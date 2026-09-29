import { randomUUID } from 'node:crypto'
import type { SessionRuntime } from './session-runtime.js'
import type { Execution, EventData } from './contracts.js'
import { snapshot, unifiedDiff, type FileSnapshot } from './file-edit.js'

type Sessions = Pick<SessionRuntime, 'latestRun' | 'append' | 'flush' | 'confirmedEvents'>
export class TaskChanges {
  constructor(private sessions: Sessions, private sessionId: string, private scope: { taskId: string; runId: string }, private maxFiles = 100) {}
  static forExecution(sessions: Sessions | undefined, exec: Execution, maxFiles = 100) {
    if (!exec.sessionId) return undefined
    if (!sessions) throw new Error('session service is required for tracked edits')
    const state = sessions.latestRun(exec.sessionId)
    if (!state || state.status !== 'running') throw new Error('tracked file tools require an active run')
    return new TaskChanges(sessions, exec.sessionId, state, maxFiles)
  }
  private events() { return this.sessions.confirmedEvents(this.sessionId).filter(event => event.taskId === this.scope.taskId) }
  private async append<K extends keyof EventData>(type: K, data: EventData[K]) {
    this.sessions.append(this.sessionId, type, data, this.scope)
    await this.sessions.flush(this.sessionId)
  }
  async observe(file: string, current: FileSnapshot) {
    const events = this.events()
    if (events.some(event => event.type === 'file/baseline' && event.data.path === file)) return
    if (events.filter(event => event.type === 'file/baseline').length >= this.maxFiles) throw new Error('task tracked file limit exceeded')
    await this.append('file/baseline', { path: file, snapshot: current })
  }
  async read(file: string, current: FileSnapshot) {
    await this.observe(file, current)
    await this.append('file/observed', { path: file, hash: current.hash })
  }
  expected(file: string): string | undefined {
    const events = this.events()
    let hash: string | undefined
    for (const event of events) {
      if (event.type === 'file/baseline' && event.data.path === file) hash = event.data.snapshot.hash
      if (event.type === 'file/observed' && event.data.path === file) hash = event.data.hash
      if (event.type === 'file/change' && event.data.path === file) {
        const result = events.find(e => e.type === 'file/change-result' && e.data.changeId === event.data.changeId)
        if (!result) throw new Error('unknown file edit outcome; verify before starting a new task')
        if (result.type === 'file/change-result' && result.data.status === 'applied') hash = event.data.after?.hash
      }
    }
    return hash
  }
  async start(data: Omit<EventData['file/change'], 'changeId'>) {
    const changeId = randomUUID()
    await this.append('file/change', { ...data, changeId })
    return changeId
  }
  async finish(changeId: string, status: EventData['file/change-result']['status'], error?: string) {
    await this.append('file/change-result', { changeId, status, ...(error === undefined ? {} : { error: error.slice(0, 2000) }) })
  }
}

export async function taskChanges(sessions: Sessions, sessionId: string, resolve: (file: string) => string, maxBytes: number, signal: AbortSignal, includeDiff = true, offset = 0, maxFiles = 100) {
  const state = sessions.latestRun(sessionId)
  if (!state) return { taskId: null, files: [], attempts: [], nextOffset: 0, eof: true, scope: 'file tools only' }
  const events = sessions.confirmedEvents(sessionId).filter(e => e.taskId === state.taskId)
  const attempts = events.filter(e => e.type === 'file/change').map(event => {
    const result = events.find(e => e.type === 'file/change-result' && e.data.changeId === event.data.changeId)
    return { ...event.data, status: result?.type === 'file/change-result' ? result.data.status : 'unknown', error: result?.type === 'file/change-result' ? result.data.error : undefined }
  })
  const paths = [...new Set(attempts.map(attempt => attempt.path))]
  const files = []
  for (const file of paths.slice(offset, offset + maxFiles)) {
    signal.throwIfAborted()
    const baseline = events.find(e => e.type === 'file/baseline' && e.data.path === file)
    const own = attempts.filter(attempt => attempt.path === file)
    const applied = own.filter(attempt => attempt.status === 'applied')
    const before = baseline?.type === 'file/baseline' ? baseline.data.snapshot : applied[0]?.before
    const after = applied.at(-1)?.after
    let expected = before?.hash, externalChangesBetweenEdits = false
    for (const attempt of applied) {
      if (attempt.before?.hash !== expected) externalChangesBetweenEdits = true
      expected = attempt.after?.hash
    }
    let currentHash: string | undefined, currentError: string | undefined
    try { currentHash = (await snapshot(resolve(file), maxBytes, signal)).hash }
    catch (error) { signal.throwIfAborted(); currentError = error instanceof Error ? error.message : String(error) }
    files.push({ path: file, status: own.some(attempt => attempt.status === 'unknown') ? 'unknown' : applied.length ? 'applied' : own.some(attempt => attempt.status === 'failed') ? 'failed' : 'unchanged',
      beforeHash: before?.hash, afterHash: after?.hash, currentHash, currentError,
      externalChange: own.some(attempt => attempt.status === 'unknown') ? undefined : currentHash !== undefined && currentHash !== (after ?? before)?.hash,
      externalChangesBetweenEdits, diffBasis: externalChangesBetweenEdits ? 'individual_edits' : 'task_baseline',
      ...(includeDiff ? { diff: externalChangesBetweenEdits ? applied.map(attempt => attempt.before && attempt.after ? unifiedDiff(file, attempt.before.text, attempt.after.text) : '').join('') : before && after ? unifiedDiff(file, before.text, after.text) : '' } : {}),
      attempts: own.map(({ changeId, tool, status, error }) => ({ changeId, tool, status, error })) })
  }
  const nextOffset = Math.min(paths.length, offset + files.length)
  return { taskId: state.taskId, files, nextOffset, eof: nextOffset >= paths.length, scope: 'file tools only; diff is confirmed edits relative to first observation; external changes are not attributed' }
}
