import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { resolveInside } from '../utils/path.js'
import { memoryHash } from './memory-contracts.js'
import { readBoundedMemoryFile } from './memory-retriever.js'
import { estimateText } from './token-estimator.js'
import { boundDelegationBatch, delegateInputs, delegationLimits, parseChildFindings } from './delegation-contracts.js'
import type { DelegateTaskInput, DelegationLimits, DelegationResult, DelegationStart, PlannedChild, DelegationBatch } from './delegation-contracts.js'
import type { Execution } from './contracts.js'
import type { SessionRuntime } from './session-runtime.js'
import type { TaskGroupBudgetCoordinator } from './task-group-budget.js'
import type { MemoryViewSnapshot } from './memory-runtime.js'
import type { MemoryController } from '../plugins/memory.js'
import type { ToolResultStore } from './tool-result-store.js'

export interface ChildBinding { sessionId: string; capabilityDigest: string; send(input: string, signal: AbortSignal): Promise<string>; status(): string | undefined; dispose(): Promise<void> }
export interface DelegationDependencies {
  workspace: string; directory: string; sessions: Pick<SessionRuntime, keyof SessionRuntime>; memory?: MemoryController; results: ToolResultStore
  group(sessionId: string, taskId: string): Promise<TaskGroupBudgetCoordinator>
  buildChild(task: DelegateTaskInput, delegationId: string, execution: Execution, group: TaskGroupBudgetCoordinator, memory?: MemoryViewSnapshot): Promise<ChildBinding>
}
export class DelegationRuntime {
  readonly limits: Readonly<DelegationLimits>
  #active = new Set<string>()
  #controllers = new Set<AbortController>()
  #pending = new Set<Promise<DelegationBatch>>()
  constructor(readonly deps: DelegationDependencies, limits: Partial<DelegationLimits> = {}) { this.limits = delegationLimits(limits) }
  async #anchors(paths: string[], sessionId: string, taskId: string) {
    const events = this.deps.sessions.confirmedEvents(sessionId).filter(event => event.taskId === taskId)
    const anchors = []
    for (const relative of [...new Set(paths)]) {
      const event = [...events].reverse().find(event => (event.type === 'file/observed' || event.type === 'file/baseline') && event.data.path === relative)
      const hash = event?.type === 'file/observed' ? event.data.hash : event?.type === 'file/baseline' ? event.data.snapshot.hash : undefined
      const bytes = await readBoundedMemoryFile(resolveInside(this.deps.workspace, relative), 1024 * 1024)
      if (!hash || hash !== memoryHash(bytes)) throw new Error('delegation context reference must match a confirmed current-task file read')
      anchors.push({ path: relative, contentSha256: hash })
    }
    return anchors
  }
  run(value: unknown, execution: Execution): Promise<DelegationBatch> {
    const operation = this.#run(value, execution); this.#pending.add(operation)
    void operation.finally(() => this.#pending.delete(operation)).catch(() => {})
    return operation
  }
  async #run(value: unknown, execution: Execution): Promise<DelegationBatch> {
    const { sessionId, toolCallId, toolSequence, agent } = execution
    if (!sessionId || !toolCallId || !toolSequence || !agent) throw new Error('delegation requires a scoped parent tool call')
    const state = this.deps.sessions.latestRun(sessionId)
    if (state?.status !== 'running' || this.#active.has(state.taskId)) throw new Error('delegation requires one active parent batch')
    const tasks = delegateInputs(value), prior = this.deps.sessions.get(sessionId).events.filter(event => event.type === 'delegation/start' && event.taskId === state.taskId)
    if (prior.reduce((sum, event) => sum + (event.type === 'delegation/start' ? event.data.children.length : 0), 0) + tasks.length > this.limits.maxChildrenPerTask) throw new Error('cumulative child limit reached')
    if (prior.some(event => event.type === 'delegation/start' && event.data.toolCallId === toolCallId && event.data.toolSequence === toolSequence)) throw new Error('delegation already started; recover its recorded result instead of rerunning')
    execution.signal.throwIfAborted()
    const group = await this.deps.group(sessionId, state.taskId), anchors = await this.#anchors(tasks.flatMap(task => task.contextRefs), sessionId, state.taskId)
    const memory = this.deps.memory ? this.deps.memory.runtime.snapshot(await this.deps.memory.view(sessionId)) : undefined
    const start: DelegationStart = { batchId: randomUUID(), groupId: group.start.groupId, toolCallId, toolSequence, anchors, limits: { ...this.limits }, children: tasks.map(task => ({ delegationId: randomUUID(), task })) }
    const append = async <K extends 'delegation/start' | 'delegation/child-created' | 'delegation/child-finish' | 'delegation/finish'>(type: K, data: import('./contracts.js').EventData[K]) => { this.deps.sessions.append(sessionId, type, data, state); await this.deps.sessions.flush(sessionId) }
    await append('delegation/start', start)
    this.#active.add(state.taskId)
    const controller = new AbortController(), signal = AbortSignal.any([execution.signal, controller.signal]); this.#controllers.add(controller)
    const results: DelegationResult[] = new Array(tasks.length)
    let next = 0
    try {
      const worker = async () => {
        while (next < start.children.length) {
          const index = next++, planned = start.children[index]
          results[index] = await this.#child(planned, { ...execution, signal }, start, group, memory, append)
        }
      }
      await Promise.all(Array.from({ length: Math.min(this.limits.maxConcurrent, tasks.length) }, worker))
      const batch = boundDelegationBatch({ batchId: start.batchId, results, truncated: false }, this.limits)
      await append('delegation/finish', { batchId: start.batchId, toolCallId, toolSequence, result: JSON.stringify(batch) })
      return batch
    } finally { this.#controllers.delete(controller); this.#active.delete(state.taskId) }
  }
  async #child(planned: PlannedChild, execution: Execution, start: DelegationStart, group: TaskGroupBudgetCoordinator, memory: MemoryViewSnapshot | undefined,
    append: <K extends 'delegation/start' | 'delegation/child-created' | 'delegation/child-finish' | 'delegation/finish'>(type: K, data: import('./contracts.js').EventData[K]) => Promise<void>) {
    let child: ChildBinding | undefined
    let result: DelegationResult = { delegationId: planned.delegationId, status: 'skipped', findings: [], unresolved: ['Cancelled before child start.'] }
    if (!execution.signal.aborted) try {
      child = await this.deps.buildChild(planned.task, planned.delegationId, execution, group, memory)
      result.childSessionId = child.sessionId
      await append('delegation/child-created', { batchId: start.batchId, delegationId: planned.delegationId, childSessionId: child.sessionId, role: planned.task.role, capabilityDigest: child.capabilityDigest })
      const prompt = JSON.stringify({ objective: planned.task.objective, outputFocus: planned.task.outputFocus, context: start.anchors.filter(anchor => planned.task.contextRefs.includes(anchor.path)), responseFormat: { findings: [{ kind: 'observation|hypothesis|recommendation', text: 'bounded finding', evidence: [{ path: 'workspace-relative', contentSha256: 'read_file hash', line: 1 }] }], unresolved: ['remaining question'] }, instructions: 'Investigate using the available read tools. Return ONLY the JSON object, within 1536 estimated tokens and 8192 bytes. Cite current file hashes. Do not claim to have run tests.' })
      const text = await child.send(prompt, execution.signal)
      if (child.status() !== 'completed') throw new Error('child did not complete')
      const findings = parseChildFindings(text, this.limits)
      for (const finding of findings.findings) for (const ref of finding.evidence) {
        const bytes = await readBoundedMemoryFile(resolveInside(this.deps.workspace, ref.path), 1024 * 1024)
        if (memoryHash(bytes) !== ref.contentSha256) throw new Error('child evidence is stale or invalid')
      }
      result = { delegationId: planned.delegationId, childSessionId: child.sessionId, status: 'completed', ...findings }
      if (Buffer.byteLength(JSON.stringify(result)) > this.limits.maxResultBytes || estimateText(JSON.stringify(result)) > this.limits.maxResultTokens) throw new Error('wrapped child result exceeds limit')
    } catch {
      result = { delegationId: planned.delegationId, ...(child ? { childSessionId: child.sessionId } : {}), status: execution.signal.aborted ? 'cancelled' : child?.status() === 'completed' ? 'invalid_result' : 'failed', findings: [], unresolved: ['Child failed, was cancelled, or returned invalid/stale evidence; inspect its recorded trace.'] }
    } finally { await child?.dispose() }
    const bytes = Buffer.from(JSON.stringify(result)), resultSha256 = memoryHash(bytes)
    const directory = path.join(this.deps.directory, execution.sessionId!, start.batchId)
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    const target = path.join(directory, `${planned.delegationId}.json`), file = await fs.open(target, 'wx', 0o600)
    try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
    // Publish a parent-owned copy; never hand a child-owned result ref across the ownership check.
    const published = await this.deps.results.save(execution.sessionId!, bytes.toString('utf8'), new AbortController().signal)
    result.resultRef = published.ref; result.resultSha256 = resultSha256
    await append('delegation/child-finish', { batchId: start.batchId, delegationId: planned.delegationId, ...(child ? { childSessionId: child.sessionId } : {}), status: result.status, resultRef: published.ref, resultSha256 })
    return result
  }
  cancel() { for (const controller of this.#controllers) controller.abort() }
  async close() { this.cancel(); await Promise.allSettled([...this.#pending]) }
}
