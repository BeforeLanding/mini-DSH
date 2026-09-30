import { randomUUID } from 'node:crypto'
import type { SessionRuntime } from './session-runtime.js'
import type { CommandResult } from './command-runner.js'
import { commandFailed } from './command-runner.js'
import { snapshot } from './file-edit.js'
import { taskChanges } from './task-changes.js'

export interface VerificationFile { path: string; hash?: string; location?: string; error?: string }
export interface VerificationStart { verificationId: string; command: string; cwd: string; toolCallId?: string; files: VerificationFile[] }
export interface VerificationResult { verificationId: string; commandResult: CommandResult; files: VerificationFile[] }
type Sessions = Pick<SessionRuntime, 'latestRun' | 'confirmedEvents' | 'append' | 'flush'>

export async function verificationFiles(paths: string[], resolve: (file: string) => string, maxBytes: number, signal: AbortSignal, tolerateErrors = false): Promise<VerificationFile[]> {
  const files: VerificationFile[] = []
  for (const file of paths) {
    signal.throwIfAborted()
    try {
      const current = await snapshot(resolve(file), maxBytes, signal)
      files.push({ path: file, hash: current.hash, ...(current.location ? { location: current.location } : {}) })
    } catch (error) {
      signal.throwIfAborted()
      if (!tolerateErrors) throw error
      files.push({ path: file, error: (error instanceof Error ? error.message : String(error)).slice(0, 2000) })
    }
  }
  return files
}
export class TaskVerification {
  constructor(private sessions: Sessions, private sessionId: string, private scope: { taskId: string; runId: string }) {}
  private async append(type: 'verification/start', data: VerificationStart): Promise<void>
  private async append(type: 'verification/result', data: VerificationResult): Promise<void>
  private async append(type: 'verification/start' | 'verification/result', data: VerificationStart | VerificationResult) {
    if (type === 'verification/start') this.sessions.append(this.sessionId, type, data as VerificationStart, this.scope)
    else this.sessions.append(this.sessionId, type, data as VerificationResult, this.scope)
    await this.sessions.flush(this.sessionId)
  }
  async start(data: Omit<VerificationStart, 'verificationId'>) {
    const verificationId = randomUUID()
    await this.append('verification/start', { ...data, verificationId })
    return verificationId
  }
  async finish(verificationId: string, commandResult: CommandResult, files: VerificationFile[]) {
    await this.append('verification/result', { verificationId, commandResult, files })
  }
}

export async function taskVerifications(sessions: Sessions, sessionId: string, resolve: (file: string) => string, maxBytes: number, signal: AbortSignal, offset = 0, maxRecords = 20) {
  const run = sessions.latestRun(sessionId)
  const events = run ? sessions.confirmedEvents(sessionId).filter(e => e.taskId === run.taskId) : []
  const starts = events.filter(e => e.type === 'verification/start')
  const records = []
  for (const event of starts.slice(offset, offset + maxRecords)) {
    const start = event.data
    const result = events.find(e => e.type === 'verification/result' && e.data.verificationId === start.verificationId)
    const current = await verificationFiles(start.files.map(file => file.path), resolve, maxBytes, signal, true)
    const outcome = result?.type === 'verification/result' ? result.data : undefined
    const after = outcome?.files
    const same = (a: VerificationFile, b: VerificationFile | undefined) => !!b && a.hash !== undefined && a.hash === b.hash && a.location === b.location
    const status = !outcome || !after ? 'unknown' : commandFailed(outcome.commandResult) ? 'failed' : after.some(file => file.error) ? 'unavailable' : start.files.every((file, index) => same(file, after[index])) ? 'passed' : 'stale'
    const laterEdit = events.some(e => e.type === 'file/change' && e.seq > event.seq && start.files.some(file => file.path === e.data.path) && events.some(r => r.type === 'file/change-result' && r.data.changeId === e.data.changeId && r.data.status === 'applied'))
    const freshness = current.some(file => file.error) ? 'unavailable' : laterEdit || !start.files.every((file, index) => same(file, current[index])) ? 'stale' : 'current'
    records.push({ ...start, runId: event.runId, status, freshness, currentFiles: current, ...(result?.type === 'verification/result' ? { commandResult: result.data.commandResult, afterFiles: result.data.files } : {}) })
  }
  const nextOffset = Math.min(starts.length, offset + records.length)
  return { taskId: run?.taskId ?? null, runStatus: run?.status ?? null, records, total: starts.length, nextOffset, eof: nextOffset >= starts.length, scope: 'declared files and commands only; passing checks do not establish task acceptance' }
}

export async function taskReport(sessions: Sessions, sessionId: string, resolve: (file: string) => string, maxBytes: number, signal: AbortSignal, fileOffset = 0, verificationOffset = 0, maxFiles = 20, maxRecords = 20) {
  const changes = await taskChanges(sessions, sessionId, resolve, maxBytes, signal, false, fileOffset, maxFiles)
  const verification = await taskVerifications(sessions, sessionId, resolve, maxBytes, signal, verificationOffset, maxRecords)
  const events = changes.taskId ? sessions.confirmedEvents(sessionId).filter(e => e.taskId === changes.taskId) : []
  const files = []
  const versions = new Map<string, VerificationFile>()
  const version = async (file: string) => {
    if (!versions.has(file)) versions.set(file, (await verificationFiles([file], resolve, maxBytes, signal, true))[0])
    return versions.get(file)!
  }
  for (const file of changes.files) {
    const current = await version(file.path)
    const coveredBy = []
    for (const event of events) {
      if (event.type !== 'verification/start') continue
      const index = event.data.files.findIndex(f => f.path === file.path)
      if (index < 0) continue
      const result = events.find(e => e.type === 'verification/result' && e.data.verificationId === event.data.verificationId)
      if (result?.type !== 'verification/result' || commandFailed(result.data.commandResult)) continue
      const stable = event.data.files.every((before, i) => {
        const after = result.data.files[i]
        return before.hash !== undefined && before.hash === after?.hash && before.location === after?.location
      })
      const before = event.data.files[index]
      const laterEdit = events.some(e => e.type === 'file/change' && e.seq > event.seq && event.data.files.some(f => f.path === e.data.path) && events.some(r => r.type === 'file/change-result' && r.data.changeId === e.data.changeId && r.data.status === 'applied'))
      let fresh = stable && !laterEdit
      if (fresh) for (const declared of event.data.files) {
        const now = await version(declared.path)
        if (now.hash === undefined || now.hash !== declared.hash || now.location !== declared.location) { fresh = false; break }
      }
      if (fresh && current.hash !== undefined && before.hash === current.hash && before.location === current.location && file.status !== 'unknown') coveredBy.push(event.data.verificationId)
    }
    files.push({ ...file, verification: coveredBy.length ? 'covered' : 'unverified', coveredBy })
  }
  // Command logs remain in immutable verification events and the original Bash result.
  const records = verification.records.map(({ commandResult, ...record }) => ({ ...record, ...(commandResult ? { commandResult: { command: commandResult.command, cwd: commandResult.cwd, status: commandResult.status, exitCode: commandResult.exitCode, signal: commandResult.signal, durationMs: commandResult.durationMs, timedOut: commandResult.timedOut, cancelled: commandResult.cancelled, stdoutTruncated: commandResult.stdout.truncated, stderrTruncated: commandResult.stderr.truncated, error: commandResult.error } } : {}) }))
  return { taskId: changes.taskId, runStatus: verification.runStatus, acceptance: 'not_asserted', files, unverifiedFiles: files.filter(f => f.verification === 'unverified').map(f => f.path), fileNextOffset: changes.nextOffset, filesEof: changes.eof, checks: records, verificationTotal: verification.total, verificationNextOffset: verification.nextOffset, verificationsEof: verification.eof, scope: 'file-tool changes; checks cover only declared files/commands; logs in verification events and original Bash result; no automatic task acceptance' }
}
