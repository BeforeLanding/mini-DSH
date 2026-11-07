import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { utf8Prefix } from '../core/tool-result-store.js'
import { TaskGroupBudgetCoordinator } from '../core/task-group-budget.js'
import { CLI_BUDGET } from '../core/budget.js'
import type { ApprovalRequest } from '../core/contracts.js'
import type { CommandOptions, CommandResult } from '../core/command-runner.js'
import type { HarnessAdapter } from '../app/create-harness.js'
import type { AttemptBudget, AttemptOutcome, HumanRequestData, PlanInput, PlanDecision, RootBudget, RootStatus, RootTerminalStatus, SubtaskSpec } from './contracts.js'
import { DEFAULT_PROTECTED_PATHS, validatePlan } from './plan.js'
import { planInputError } from './validation.js'
import { newRootId, OrchestrationStore, orchestrationDirectory, writeArtifact } from './store.js'
import { OrchestrationGroupJournal } from './group-journal.js'
import { foldOrchestration, orchestrationTotals } from './state.js'
import type { AttemptState, OrchestrationState } from './state.js'
import { headCommit, repositoryRoot } from './git.js'
import { attemptBranch, integrationBranchName, WorktreeManager } from './worktrees.js'
import { runWorker } from './worker.js'
import type { WorkerAssignment, WorkerOutcome } from './worker.js'
import { applyAttempt, collectAndCommit, finishIntegration, openIntegration } from './integrator.js'
import { verifyIntegration } from './verifier.js'
import { runPlanner } from './planner.js'
import { ApprovalBroker } from './approval-broker.js'
import { noFaults, SimulatedCrash } from './faults.js'
import type { FaultInjector } from './faults.js'

export const DEFAULT_ROOT_BUDGET: Readonly<RootBudget> = Object.freeze({
  maxModelRequests: 96, maxTotalTokens: 2_000_000, maxWallMs: 1_800_000, maxToolCalls: 256,
  plannerShare: 0.1, fixReserveTokens: 200_000, maxInFlightRequests: 2,
})
export const DEFAULT_WORKER_BUDGET: Readonly<AttemptBudget> = Object.freeze({ maxModelRequests: 32, maxToolCalls: 64, maxTotalTokens: 1_000_000 })
const ROOT_BUDGET_KEYS = new Set(['maxModelRequests', 'maxTotalTokens', 'maxWallMs', 'maxToolCalls', 'plannerShare', 'fixReserveTokens', 'maxInFlightRequests', 'maxUsd'])
const BUDGET_STOPS = new Set(['max_steps', 'max_tool_calls', 'token_budget', 'timeout', 'request_timeout', 'approval_timeout', 'context_overflow', 'output_limit'])
const TERMINAL_ATTEMPTS = new Set(['finished', 'failed', 'interrupted', 'skipped', 'cancelled'])
const bounded = (text: string, limit: number) => Buffer.byteLength(text) <= limit ? text : utf8Prefix(Buffer.from(text), limit).toString('utf8')
export function resolveRootBudget(overrides: Partial<RootBudget> = {}, maxWorkers = 2): RootBudget {
  for (const key of Object.keys(overrides)) if (!ROOT_BUDGET_KEYS.has(key)) throw new Error(`unknown root budget key: ${key}`)
  const budget: RootBudget = { ...DEFAULT_ROOT_BUDGET, maxInFlightRequests: maxWorkers + 1, ...overrides }
  for (const key of ['maxModelRequests', 'maxTotalTokens', 'maxWallMs', 'maxToolCalls', 'fixReserveTokens'] as const)
    if (!Number.isSafeInteger(budget[key]) || budget[key] < (key === 'fixReserveTokens' ? 0 : 1)) throw new Error(`invalid root budget ${key}`)
  if (!Number.isSafeInteger(budget.maxInFlightRequests) || budget.maxInFlightRequests < 1 || budget.maxInFlightRequests > 8) throw new Error('invalid root budget maxInFlightRequests')
  if (!Number.isFinite(budget.plannerShare) || budget.plannerShare < 0 || budget.plannerShare > 1) throw new Error('invalid root budget plannerShare')
  if (budget.maxUsd !== undefined && (!Number.isFinite(budget.maxUsd) || budget.maxUsd <= 0)) throw new Error('invalid root budget maxUsd')
  if (budget.maxWallMs > 2_147_483_647) throw new Error('invalid root budget maxWallMs')
  return budget
}
export interface ApprovalPolicy {
  writes: 'auto' | 'ask'
  bash: 'ask' | 'auto'
  perRequestTimeoutMs?: number
  approve?: (request: ApprovalRequest) => Promise<boolean>
}
export interface OrchestrateCommonOptions {
  baseDirectory: string
  adapter: HarnessAdapter
  model?: string
  rootBudget?: Partial<RootBudget>
  workerBudget?: Partial<AttemptBudget>
  prepareCommand?: string
  verifyCommands?: string[]
  approval?: ApprovalPolicy
  decide?: (request: HumanRequestData) => Promise<string | undefined>
  commandRunner?: (options: CommandOptions) => Promise<CommandResult>
  // 第一次 Ctrl-C：停止派发，运行中的 attempt 继续到自然结束。
  dispatchSignal?: AbortSignal
  // 第二次 Ctrl-C / 外部取消：中止运行中的 run，不整合。
  signal?: AbortSignal
  clock?: () => number
  onProgress?: (line: string) => void
  faults?: FaultInjector
}
export interface OrchestrateOptions extends OrchestrateCommonOptions {
  repository: string
  goal: string
  // 缺省时由只读 planner 生成计划；提供时以计划文件为准。
  plan?: PlanInput
  mode?: 'auto' | 'single' | 'parallel'
  maxWorkers?: number
  maxSubtasks?: number
  maxAttemptsPerSubtask?: number
  allowDirty?: boolean
}
export interface OrchestrateResult {
  rootId: string
  status: RootStatus
  directory: string
  baseCommit: string
  integrationBranch?: string
  reportRef?: string
  error?: string
}
type CollectedCode = { commit?: string; tree?: string; changedFiles: string[]; scopeViolations: string[] }
interface AttemptResult {
  attemptId: string
  subtaskId: string
  wave: number
  epoch: number
  outcome: AttemptOutcome
  commit?: string
  tree?: string
  changedFiles: string[]
  scopeViolations: string[]
  summary?: string
  detail?: string
  sessionId?: string
  runStatus: string
}
interface RootContext {
  options: OrchestrateCommonOptions
  store: OrchestrationStore
  manager: WorktreeManager
  broker: ApprovalBroker
  writeSets: Map<string, string[]>
  group: TaskGroupBudgetCoordinator
  stop: StopController
  budget: RootBudget
  plan: PlanInput
  decision: PlanDecision
  verifyCommands: readonly string[]
  maxWorkers: number
  maxAttemptsPerSubtask: number
  repository: string
  rootId: string
  directory: string
  goal: string
  baseCommit: string
  clean: { baseCommit: string; dirty: number }
  model: string
  progress: (line: string) => void
  faults: FaultInjector
  signal: AbortSignal
  retry: ReadonlySet<string>
  skip: ReadonlySet<string>
}
interface RootOutcome { status: RootStatus; failureDetail?: string; integrationBranch?: string; crashed?: boolean }
function allocateBudget(root: RootBudget, worker: Partial<AttemptBudget> = {}): AttemptBudget {
  for (const [key, value] of Object.entries(worker)) {
    if (!['maxModelRequests', 'maxToolCalls', 'maxTotalTokens'].includes(key)) throw new Error(`unknown worker budget key: ${key}`)
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error(`invalid worker budget ${key}`)
  }
  const base = { ...DEFAULT_WORKER_BUDGET, ...worker }
  return {
    maxModelRequests: Math.min(base.maxModelRequests, root.maxModelRequests),
    maxToolCalls: Math.min(base.maxToolCalls, root.maxToolCalls),
    maxTotalTokens: Math.min(base.maxTotalTokens, root.maxTotalTokens),
  }
}
// 波次预算按“根余额 ÷ 本波次待启动 attempt 数”切分；根账本仍是外层硬约束。
function waveBudget(root: RootBudget, state: OrchestrationState, count: number, worker: Partial<AttemptBudget> = {}): AttemptBudget {
  const base = allocateBudget(root, worker), totals = orchestrationTotals(state)
  const spent = totals.providerTokens + totals.estimatedTokens + totals.unknownChargedTokens + totals.outstandingTokens
  const share = (remaining: number, cap: number) => Math.max(1, Math.min(cap, Math.floor(Math.max(0, remaining) / Math.max(1, count))))
  return {
    maxModelRequests: share(root.maxModelRequests - totals.requests, base.maxModelRequests),
    maxToolCalls: share(root.maxToolCalls - state.ledger.tools.length, base.maxToolCalls),
    maxTotalTokens: share(root.maxTotalTokens - spent, base.maxTotalTokens),
  }
}
function plannerBudget(root: RootBudget): AttemptBudget {
  return {
    maxModelRequests: Math.min(16, root.maxModelRequests),
    maxToolCalls: Math.min(32, root.maxToolCalls),
    maxTotalTokens: Math.max(1, Math.floor(root.maxTotalTokens * root.plannerShare)),
  }
}
function epochFor(state: OrchestrationState, subtaskId: string) {
  return state.attemptOrder.filter(attemptId => state.attempts[attemptId]!.subtaskId === subtaskId).length + 1
}
function hasTerminalAttempt(state: OrchestrationState, subtaskId: string) {
  return state.attemptOrder.some(attemptId => {
    const attempt = state.attempts[attemptId]!
    return attempt.subtaskId === subtaskId && TERMINAL_ATTEMPTS.has(attempt.status)
  })
}
function dependenciesIntegrated(subtask: SubtaskSpec, integrated: ReadonlySet<string>) {
  return (subtask.dependsOn ?? []).every(id => integrated.has(id))
}
function taskDependencies(state: OrchestrationState, subtask: SubtaskSpec) {
  return (subtask.dependsOn ?? []).flatMap(subtaskId => {
    const attemptId = [...state.attemptOrder].reverse().find(id => {
      const attempt = state.attempts[id]!
      return attempt.subtaskId === subtaskId && attempt.outcome === 'succeeded' && attempt.commit !== undefined
    })
    if (!attemptId) return []
    const attempt = state.attempts[attemptId]!
    return [{ subtaskId, commit: attempt.commit!, changedFiles: [...attempt.changedFiles], summary: attempt.summary ?? '' }]
  })
}
function formatError(error: unknown) { return bounded(error instanceof Error ? error.message : String(error), 1024) }
// 冲突处置选项：已用 attempt 数达到上限时不再提供串行重跑。
export function conflictOptions(attemptsUsed: number, maxAttempts: number): string[] {
  return attemptsUsed < maxAttempts ? ['rerun-serially', 'skip-subtask', 'abort'] : ['skip-subtask', 'abort']
}
// 简单并发池：最多 limit 个 worker 同时运行；某个 attempt 结束后再补位。
// 崩溃时等待兄弟 worker 收到中止并收尾后再抛出，避免它们在编排日志关闭后继续写。
async function pool<T, R>(items: readonly T[], limit: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const runners = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      results[index] = await work(items[index]!, index)
    }
  })
  const settled = await Promise.allSettled(runners)
  const rejected = settled.find((item): item is PromiseRejectedResult => item.status === 'rejected')
  if (rejected) throw rejected.reason
  return results
}

// 两级停止：第一次 Ctrl-C 只停止派发，第二次中止运行中的 run。wall 截止按同一路径停止运行中。
// control/stop 按发生顺序落盘；信号监听在 close 后不再写日志。
class StopController {
  dispatch = false
  running = false
  reason?: string
  #abort = new AbortController()
  #pending: Promise<void> = Promise.resolve()
  #closed = false
  constructor(private store: OrchestrationStore, private clock: () => number, private deadline: number, options: {
    dispatchSignal?: AbortSignal
    runningSignal?: AbortSignal
    initial?: { dispatch: boolean; running: boolean; reason?: string }
  } = {}) {
    if (options.initial?.dispatch) this.dispatch = true
    if (options.initial?.running) { this.running = true; this.dispatch = true; this.#abort.abort() }
    if (options.initial?.reason) this.reason = options.initial.reason
    options.dispatchSignal?.addEventListener('abort', () => { void this.stopDispatch('interrupt signal') }, { once: true })
    options.runningSignal?.addEventListener('abort', () => { void this.stopRunning('interrupt signal') }, { once: true })
    if (options.dispatchSignal?.aborted) void this.stopDispatch('interrupt signal')
    if (options.runningSignal?.aborted) void this.stopRunning('interrupt signal')
  }
  get signal() { return this.#abort.signal }
  abort() { if (!this.#abort.signal.aborted) this.#abort.abort() }
  stopDispatch(reason: string) {
    if (this.#closed) return this.#pending
    if (this.dispatch) return this.#pending
    this.dispatch = true
    this.reason ??= reason
    this.#pending = this.#pending.then(async () => { await this.store.append('control/stop', { scope: 'dispatch', reason: bounded(reason, 512) }) })
    return this.#pending
  }
  stopRunning(reason: string) {
    if (this.#closed) return this.#pending
    if (this.running) return this.#pending
    this.running = true
    this.dispatch = true
    this.reason ??= reason
    this.abort()
    this.#pending = this.#pending.then(async () => { await this.store.append('control/stop', { scope: 'running', reason: bounded(reason, 512) }) })
    return this.#pending
  }
  tick() {
    if (!this.running && this.clock() >= this.deadline) void this.stopRunning('wall deadline')
  }
  close() { this.#closed = true }
  async flush() { await this.#pending.catch(() => {}) }
}

function applyBroker(
  options: OrchestrateCommonOptions, store: OrchestrationStore, writeSets: Map<string, string[]>,
  perRequestTimeoutMs: number,
) {
  const approval = options.approval ?? { writes: 'auto', bash: 'ask' }
  const broker = new ApprovalBroker({
    policy: { writes: approval.writes, bash: approval.bash, perRequestTimeoutMs },
    ...(approval.approve ? { prompt: approval.approve } : {}),
    writeSetFor: attemptId => writeSets.get(attemptId),
    onRequested: async data => { await store.append('approval/requested', data) },
    onResolved: async data => { await store.append('approval/resolved', data) },
  })
  return { broker, perRequestTimeoutMs }
}

async function executeRoot(ctx: RootContext): Promise<RootOutcome> {
  const { store, manager, broker, group, stop, options, plan, progress, writeSets } = ctx
  const load = async () => foldOrchestration(await store.read())
  let state = await load()
  const integrated = new Set<string>()
  for (const integration of state.integrations)
    for (const applied of integration.applied) {
      const attempt = state.attempts[applied.attemptId]
      if (attempt?.outcome === 'succeeded') integrated.add(attempt.subtaskId)
    }
  let currentHead = ctx.baseCommit
  for (const integration of state.integrations) if (integration.status === 'finished' && integration.head) currentHead = integration.head
  let integrationPath: string | undefined = state.integrations.length ? manager.layout.integration : undefined
  let finalStatus: RootStatus = 'failed'
  let failureDetail: string | undefined
  let integrationBranch: string | undefined
  let needsHuman = false

  const skippedAttempt = async (subtask: SubtaskSpec, wave: number, reason: string) => {
    const current = await load()
    const planned = current.attemptOrder.map(id => current.attempts[id]!).find(item => item.subtaskId === subtask.id && item.status === 'planned')
    if (planned) {
      await store.append('attempt/finished', { attemptId: planned.attemptId, outcome: 'skipped', run: { status: 'skipped' }, code: { changedFiles: [], scopeViolations: [] }, detail: bounded(reason, 1024) })
      return
    }
    const epoch = epochFor(current, subtask.id)
    if (epoch > ctx.maxAttemptsPerSubtask) return
    const attemptId = `at_${randomUUID()}`
    await store.append('attempt/planned', { attemptId, subtaskId: subtask.id, epoch, wave, baseCommit: currentHead, budget: { maxModelRequests: 1, maxToolCalls: 1, maxTotalTokens: 1 } })
    await store.append('attempt/finished', { attemptId, outcome: 'skipped', run: { status: 'skipped' }, code: { changedFiles: [], scopeViolations: [] }, detail: bounded(reason, 1024) })
    progress(`attempt ${attemptId} ${subtask.id} skipped: ${reason}`)
  }

  const executeAttempt = async (input: {
    subtask: SubtaskSpec; wave: number; planned?: AttemptState; baseCommit: string; budget: AttemptBudget; state: OrchestrationState
  }): Promise<AttemptResult> => {
    const planned = input.planned
    const attemptId = planned?.attemptId ?? `at_${randomUUID()}`
    const epoch = planned?.epoch ?? epochFor(input.state, input.subtask.id)
    const baseCommit = planned?.baseCommit ?? input.baseCommit
    const budget = planned?.budget ?? input.budget
    const branch = attemptBranch(ctx.rootId, input.subtask.id, epoch)
    const worktree = manager.layout.attempt(attemptId)
    const sessionDirectory = path.join(manager.layout.root, 'sessions', attemptId)
    if (!planned) {
      await store.append('attempt/planned', { attemptId, subtaskId: input.subtask.id, epoch, wave: input.wave, baseCommit, budget })
      await ctx.faults.checkpoint('after-attempt-planned')
    }
    await store.append('attempt/started', { attemptId, worktree, branch, sessionDirectory })
    writeSets.set(attemptId, [...input.subtask.writeSet])
    progress(`attempt ${attemptId} ${input.subtask.id} epoch=${epoch} on ${branch}`)
    await ctx.faults.checkpoint('after-attempt-started')
    let outcome: WorkerOutcome | undefined
    let classification: AttemptOutcome = 'failed', runStatus = 'setup_failed', stopReason: string | undefined
    let code: CollectedCode = { changedFiles: [], scopeViolations: [] }
    let summary: string | undefined, detail: string | undefined
    let recorded = false
    try {
      if (stop.running || ctx.signal.aborted) {
        classification = 'cancelled'
        runStatus = 'cancelled'
      } else {
        await manager.createAttempt({ attemptId, subtaskId: input.subtask.id, epoch, baseCommit })
        await manager.prepare(worktree)
        const dependencies = taskDependencies(input.state, input.subtask)
        const assignment: WorkerAssignment = {
          rootGoal: ctx.goal, subtaskId: input.subtask.id, title: input.subtask.title, objective: input.subtask.objective,
          writeSet: input.subtask.writeSet, readHints: input.subtask.readHints ?? [], acceptance: input.subtask.acceptance,
          ...(ctx.plan.sharedNotes ? { sharedNotes: ctx.plan.sharedNotes } : {}), baseCommit, planVersion: 1,
          ...(dependencies.length ? { dependencies } : {}),
        }
        outcome = await runWorker({
          assignment, rootId: ctx.rootId, attemptId, worktree, layout: manager.layout, adapter: options.adapter, model: ctx.model, rootGroup: group,
          budget, signal: ctx.signal, approve: request => broker.request(attemptId, request),
          approvalTimeoutMs: (options.approval?.perRequestTimeoutMs ?? CLI_BUDGET.approvalTimeoutMs ?? 300_000) * (ctx.maxWorkers + 1),
          onSession: async sessionId => { await store.append('attempt/session', { attemptId, sessionId }) },
          ...(options.commandRunner ? { commandRunner: options.commandRunner } : {}),
        })
        await ctx.faults.checkpoint('after-worker-run')
        runStatus = outcome.runStatus
        stopReason = outcome.stopReason
        if (runStatus !== 'completed') classification = runStatus === 'cancelled' ? 'cancelled' : BUDGET_STOPS.has(runStatus) ? 'budget_stopped' : 'run_failed'
        else if (outcome.report.valid && outcome.report.status !== 'done') classification = 'needs_input'
        else {
          const collected = await collectAndCommit({
            worktree, baseCommit, writeSet: input.subtask.writeSet, rootId: ctx.rootId, attemptId, subtaskId: input.subtask.id,
            ...(options.signal ? { signal: options.signal } : {}),
          })
          classification = collected.outcome
          code = {
            ...(collected.commit ? { commit: collected.commit } : {}), ...(collected.tree ? { tree: collected.tree } : {}),
            changedFiles: collected.changedFiles, scopeViolations: collected.scopeViolations,
          }
        }
        summary = outcome.report.summary ? bounded(outcome.report.summary, 1024) : undefined
        if (classification === 'needs_input') detail = bounded(outcome.report.summary || 'worker requested input', 1024)
        const artifact = await writeArtifact(path.join(store.directory, 'artifacts'), {
          assignment: { subtaskId: input.subtask.id, title: input.subtask.title, objective: input.subtask.objective, writeSet: input.subtask.writeSet },
          run: { status: runStatus, stopReason }, report: outcome.report, usage: outcome.usage,
          final: bounded(outcome.finalContent, 16 * 1024), ...(outcome.error ? { error: outcome.error } : {}), code,
        }).catch(() => undefined)
        await store.append('attempt/finished', {
          attemptId, outcome: classification,
          run: { sessionId: outcome.sessionId, status: runStatus, ...(stopReason ? { stopReason } : {}) },
          code, ...(artifact ? { resultRef: artifact.ref } : {}), ...(summary ? { summary } : {}), ...(detail ? { detail } : {}),
        })
        recorded = true
        progress(`attempt ${attemptId} ${classification}`)
      }
      if (!recorded) {
        await store.append('attempt/finished', { attemptId, outcome: classification, run: { status: runStatus }, code: { changedFiles: [], scopeViolations: [] }, ...(detail ? { detail } : {}) })
        recorded = true
      }
      await ctx.faults.checkpoint('after-attempt-finished')
    } catch (error) {
      if (error instanceof SimulatedCrash) {
        stop.abort()
        throw error
      }
      detail = formatError(error)
      classification = stop.running ? 'cancelled' : 'failed'
      if (!recorded) {
        try { await store.append('attempt/finished', { attemptId, outcome: classification, run: { status: 'error' }, code: { changedFiles: [], scopeViolations: [] }, detail }) } catch { /* the root report carries the failure */ }
      }
    } finally {
      broker.cancelAttempt(attemptId)
    }
    return {
      attemptId, subtaskId: input.subtask.id, wave: input.wave, epoch, outcome: classification,
      ...(code.commit ? { commit: code.commit } : {}), ...(code.tree ? { tree: code.tree } : {}),
      changedFiles: code.changedFiles, scopeViolations: code.scopeViolations,
      ...(summary ? { summary } : {}), ...(detail ? { detail } : {}), ...(outcome?.sessionId ? { sessionId: outcome.sessionId } : {}), runStatus,
    }
  }

  outer: for (const [waveIndex, waveIds] of ctx.decision.waves.entries()) {
    if (stop.running) break
    state = await load()
    const runnable: { subtask: SubtaskSpec; planned?: AttemptState }[] = []
    for (const subtaskId of waveIds) {
      if (integrated.has(subtaskId) || ctx.skip.has(subtaskId)) continue
      const subtask = plan.subtasks.find(item => item.id === subtaskId)!
      if (!dependenciesIntegrated(subtask, integrated)) {
        await skippedAttempt(subtask, waveIndex, `dependencies are not integrated: ${(subtask.dependsOn ?? []).filter(id => !integrated.has(id)).join(', ')}`)
        continue
      }
      const attempts = state.attemptOrder.map(id => state.attempts[id]!).filter(item => item.subtaskId === subtaskId)
      const planned = attempts.find(item => item.status === 'planned')
      const terminal = attempts.some(item => TERMINAL_ATTEMPTS.has(item.status))
      if (terminal && !ctx.retry.has(subtaskId)) continue
      if (stop.dispatch) { await skippedAttempt(subtask, waveIndex, 'dispatch stopped'); continue }
      if (!planned && epochFor(state, subtaskId) > ctx.maxAttemptsPerSubtask) {
        progress(`${subtaskId} has no attempt left; it stays unintegrated`)
        continue
      }
      runnable.push({ subtask, ...(planned ? { planned } : {}) })
    }
    if (!runnable.length) {
      if (stop.dispatch) break
      continue
    }
    const allocation = waveBudget(ctx.budget, state, runnable.length, options.workerBudget)
    progress(`wave ${waveIndex + 1}/${ctx.decision.waves.length}: ${runnable.map(item => item.subtask.id).join(', ')} (${ctx.decision.mode})`)
    await pool(runnable, ctx.decision.mode === 'parallel' ? ctx.maxWorkers : 1, async item => {
      if (stop.dispatch || ctx.signal.aborted) {
        await skippedAttempt(item.subtask, waveIndex, 'dispatch stopped')
        return undefined
      }
      return executeAttempt({ subtask: item.subtask, wave: waveIndex, ...(item.planned ? { planned: item.planned } : {}), baseCommit: currentHead, budget: allocation, state })
    })
    if (stop.running) break
    // 以日志为准收集本波次已成功但尚未整合的 attempt；这同时覆盖崩溃后重新进入的波次。
    state = await load()
    const appliedIds = new Set(state.integrations.flatMap(integration => integration.applied.map(item => item.attemptId)))
    const order = new Map(waveIds.map((id, index) => [id, index]))
    const successes = state.attemptOrder.map(id => state.attempts[id]!)
      .filter(item => order.has(item.subtaskId) && item.outcome === 'succeeded' && item.commit !== undefined && !appliedIds.has(item.attemptId) && !integrated.has(item.subtaskId))
      .sort((left, right) => order.get(left.subtaskId)! - order.get(right.subtaskId)!)
    if (!successes.length) {
      if (stop.dispatch) break
      continue
    }
    const opened = await openIntegration({ store, manager, wave: waveIndex, baseCommit: currentHead, ...(options.signal ? { signal: options.signal } : {}) })
    integrationPath = opened.path
    await ctx.faults.checkpoint('after-integration-started')
    for (const original of successes) {
      let candidate = { attemptId: original.attemptId, subtaskId: original.subtaskId, commit: original.commit! }
      for (;;) {
        if (stop.running) break outer
        const applied = await applyAttempt({
          store, integrationId: opened.integrationId, path: opened.path, attempt: candidate, faults: ctx.faults,
          ...(options.signal ? { signal: options.signal } : {}),
        })
        if (applied.status === 'applied') { integrated.add(candidate.subtaskId); break }
        const conflictState = await load()
        const request: HumanRequestData = {
          requestId: `hr_${randomUUID()}`, kind: 'conflict', attemptId: candidate.attemptId,
          prompt: `${candidate.subtaskId} 与已整合内容冲突：${applied.conflict.files.join(', ')}。`,
          options: conflictOptions(epochFor(conflictState, candidate.subtaskId) - 1, ctx.maxAttemptsPerSubtask),
        }
        await store.append('human/requested', request)
        progress(`integration conflict on ${candidate.subtaskId}: ${applied.conflict.files.join(', ')}`)
        const choice = await options.decide?.(request)
        if (!choice || !request.options.includes(choice)) {
          needsHuman = true
          break outer
        }
        await store.append('human/resolved', { requestId: request.requestId, choice, actor: 'local-user' })
        if (choice === 'abort') {
          await stop.stopRunning('conflict aborted by user')
          break outer
        }
        if (choice === 'skip-subtask') {
          progress(`skipped ${candidate.subtaskId}; it stays unintegrated`)
          break
        }
        const rerunState = await load()
        const epoch = epochFor(rerunState, candidate.subtaskId)
        if (epoch > ctx.maxAttemptsPerSubtask) {
          progress(`no attempt budget left for ${candidate.subtaskId}; it stays unintegrated`)
          break
        }
        const subtask = plan.subtasks.find(item => item.id === candidate.subtaskId)!
        const rerunBase = await headCommit(opened.path)
        const rerun = await executeAttempt({
          subtask, wave: waveIndex, baseCommit: rerunBase, budget: waveBudget(ctx.budget, rerunState, 1, options.workerBudget), state: rerunState,
        })
        if (rerun.outcome !== 'succeeded' || !rerun.commit) {
          progress(`rerun ${rerun.attemptId} ${rerun.outcome}; ${candidate.subtaskId} stays unintegrated`)
          break
        }
        candidate = { attemptId: rerun.attemptId, subtaskId: rerun.subtaskId, commit: rerun.commit }
      }
    }
    if (stop.running || needsHuman) break
    const finished = await finishIntegration({ store, integrationId: opened.integrationId, path: opened.path })
    currentHead = finished.head
    integrationBranch = integrationBranchName(ctx.rootId)
    progress(`integration wave ${waveIndex + 1} ${finished.head}`)
    if (stop.dispatch) break
  }

  if (stop.running) return { status: 'cancelled', ...(stop.reason ? { failureDetail: `stopped: ${stop.reason}` } : {}), ...(integrationBranch ? { integrationBranch } : {}) }
  if (needsHuman) return { status: 'needs_human', ...(integrationBranch ? { integrationBranch } : {}) }
  state = await load()
  if (state.integration?.status === 'finished' && integrationPath && state.integration.head && state.integration.tree) {
    const head = state.integration.head, tree = state.integration.tree
    const commands = new Set<string>()
    for (const subtaskId of integrated) {
      const subtask = plan.subtasks.find(item => item.id === subtaskId)
      for (const command of subtask?.acceptance.commands ?? []) commands.add(command)
    }
    for (const command of ctx.verifyCommands) commands.add(command)
    const recorded = new Set(state.verifications.filter(item => item.head === head && item.tree === tree).map(item => item.command))
    const missing = [...commands].filter(command => !recorded.has(command))
    if (missing.length) {
      await ctx.faults.checkpoint('before-verification')
      const verification = await verifyIntegration({
        store, worktree: integrationPath, head, tree, commands: missing, faults: ctx.faults,
        ...(options.signal ? { signal: options.signal } : {}),
      })
      progress(`verification ${verification.passed ? 'passed' : 'failed'}`)
    }
    state = await load()
    const evidence = state.verifications.filter(item => item.head === head && item.tree === tree)
    const passed = evidence.length > 0 && evidence.every(item => item.exitCode === 0)
    const complete = ctx.decision.waves.flat().every(id => integrated.has(id))
    if (!passed) { finalStatus = 'failed'; failureDetail = 'integrated verification failed' }
    else if (complete) finalStatus = 'completed'
    else if (integrated.size > 0) finalStatus = 'partial'
    else { finalStatus = 'failed'; failureDetail = 'no subtask was integrated' }
  } else {
    finalStatus = 'failed'
    failureDetail ??= 'no attempt produced an integrable change'
  }
  return { status: finalStatus, ...(failureDetail ? { failureDetail } : {}), ...(integrationBranch ? { integrationBranch } : {}) }
}

export async function orchestrate(options: OrchestrateOptions): Promise<OrchestrateResult> {
  const progress = options.onProgress ?? (() => {})
  const maxWorkers = options.maxWorkers ?? 2, maxSubtasks = options.maxSubtasks ?? 4, maxAttemptsPerSubtask = options.maxAttemptsPerSubtask ?? 2
  if (!Number.isSafeInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 4) throw new Error('maxWorkers must be 1..4')
  if (!Number.isSafeInteger(maxSubtasks) || maxSubtasks < 1 || maxSubtasks > 6) throw new Error('maxSubtasks must be 1..6')
  if (!Number.isSafeInteger(maxAttemptsPerSubtask) || maxAttemptsPerSubtask < 1 || maxAttemptsPerSubtask > 8) throw new Error('maxAttemptsPerSubtask must be 1..8')
  const budget = resolveRootBudget(options.rootBudget, maxWorkers)
  if (options.plan) {
    const structural = planInputError(options.plan)
    if (structural) throw new Error(structural)
  }
  const repository = await repositoryRoot(options.repository)
  const rootId = newRootId(), directory = orchestrationDirectory(options.baseDirectory, rootId)
  const manager = new WorktreeManager(repository, rootId, directory, { ...(options.prepareCommand ? { prepareCommand: options.prepareCommand } : {}), ...(options.signal ? { signal: options.signal } : {}) })
  const clean = await manager.assertClean({ allowDirty: options.allowDirty })
  const baseCommit = clean.baseCommit
  const store = await OrchestrationStore.open(directory, rootId)
  const writeSets = new Map<string, string[]>()
  const perRequestTimeoutMs = options.approval?.perRequestTimeoutMs ?? CLI_BUDGET.approvalTimeoutMs ?? 300_000
  const { broker } = applyBroker(options, store, writeSets, perRequestTimeoutMs)
  const model = options.model ?? `${options.adapter.provider}/${options.adapter.model}`
  const protectedPaths = DEFAULT_PROTECTED_PATHS
  const faults = options.faults ?? noFaults
  let finalStatus: RootStatus = 'failed', reportRef: string | undefined, integrationBranch: string | undefined
  let failureDetail: string | undefined, crashed = false
  let stopTimer: ReturnType<typeof setInterval> | undefined
  let stop: StopController | undefined
  try {
    await store.append('root/start', {
      goal: bounded(options.goal, 4096), repository, baseCommit,
      config: { mode: options.mode ?? 'auto', maxWorkers, maxSubtasks, maxAttemptsPerSubtask }, budget,
      ...(options.verifyCommands?.length ? { verifyCommands: options.verifyCommands } : {}),
      ...(options.prepareCommand ? { prepareCommand: options.prepareCommand } : {}),
    })
    await faults.checkpoint('after-root-start')
    progress(`root ${rootId} @ ${baseCommit}`)
    const group = await TaskGroupBudgetCoordinator.openJournal(new OrchestrationGroupJournal(store), {
      maxModelRequests: budget.maxModelRequests, maxToolCalls: budget.maxToolCalls, maxTotalTokens: budget.maxTotalTokens,
      rootTokenFloor: 0, rootRequestFloor: 0, maxWallDurationMs: budget.maxWallMs, maxInFlightRequests: budget.maxInFlightRequests,
    }, options.clock ?? Date.now)
    const clock = options.clock ?? Date.now
    stop = new StopController(store, clock, group.start.deadline, {
      ...(options.dispatchSignal ? { dispatchSignal: options.dispatchSignal } : {}),
      ...(options.signal ? { runningSignal: options.signal } : {}),
    })
    stopTimer = setInterval(() => stop?.tick(), 50)
    stopTimer.unref?.()
    const signal = AbortSignal.any([group.signal, stop.signal, ...(options.signal ? [options.signal] : [])])
    let plan = options.plan
    let planSource: 'file' | 'model' = 'file'
    let plannerSessionId: string | undefined
    if (!plan) {
      await faults.checkpoint('before-planning')
      const baseWorktree = await manager.createBaseSnapshot(baseCommit)
      progress(`planner reading ${baseWorktree}`)
      const planned = await runPlanner({
        goal: bounded(options.goal, 4096), rootId, worktree: baseWorktree, layout: manager.layout, adapter: options.adapter,
        model, rootGroup: group, budget: plannerBudget(budget), signal, maxSubtasks, protectedPaths,
        onSession: sessionId => { plannerSessionId = sessionId; progress(`planner session ${sessionId}`) },
      })
      plan = planned.plan
      planSource = 'model'
      plannerSessionId = planned.sessionId
    }
    const selectedPlan: PlanInput = plan
    const validation = validatePlan(selectedPlan, { maxSubtasks, mode: options.mode ?? 'auto', protectedPaths, workspace: repository })
    await store.append('plan/recorded', {
      planId: `pl_${randomUUID()}`, planVersion: 1, source: planSource, ...(plannerSessionId ? { plannerSessionId } : {}),
      plan: selectedPlan, validation: validation.ok ? { ok: true, waves: validation.decision.waves } : { ok: false, errors: validation.errors },
    })
    if (!validation.ok) throw new Error(bounded(`invalid plan: ${validation.errors.join('; ')}`, 1024))
    const decision: PlanDecision = { planVersion: 1, mode: validation.decision.mode, reason: validation.decision.reason, waves: validation.decision.waves }
    await store.append('plan/decision', decision)
    progress(`plan ${decision.mode}: ${decision.reason}`)
    await faults.checkpoint('after-plan-decision')
    if (stop.dispatch || stop.running) {
      finalStatus = 'cancelled'
    } else {
      const outcome = await executeRoot({
        options, store, manager, broker, group, stop, budget, plan: selectedPlan, decision, writeSets,
        verifyCommands: options.verifyCommands ?? [], maxWorkers, maxAttemptsPerSubtask, repository, rootId, directory,
        goal: options.goal, baseCommit, clean, model, progress, faults, signal, retry: new Set(), skip: new Set(),
      })
      finalStatus = outcome.status
      failureDetail = outcome.failureDetail
      integrationBranch = outcome.integrationBranch
    }
  } catch (error) {
    if (error instanceof SimulatedCrash) {
      crashed = true
      failureDetail = error.message
      progress(error.message)
    } else {
      failureDetail = formatError(error)
      finalStatus = 'failed'
    }
  } finally {
    stop?.close()
    if (stopTimer) clearInterval(stopTimer)
    await stop?.flush()
    // 先关闭审批通道：关闭时被拒绝的请求仍会写审计事件，必须发生在 root/finish 之前。
    await broker.close().catch(() => {})
    if (!crashed) {
      try {
        const events = await store.read()
        const state = foldOrchestration(events)
        const report = {
          rootId, status: finalStatus, goal: options.goal, baseCommit, repository,
          ...(failureDetail ? { failure: failureDetail } : {}),
          plan: state.plan, decision: state.decision, attempts: state.attemptOrder.map(id => state.attempts[id]),
          integrations: state.integrations, verification: state.verifications, approvals: state.approvals,
          human: state.human, ledger: orchestrationTotals(state),
          dirtyBaseline: clean.dirty > 0, paths: { directory, worktrees: manager.layout.worktrees, sessions: path.join(directory, 'sessions') },
        }
        reportRef = (await writeArtifact(path.join(store.directory, 'artifacts'), report)).ref
        if (finalStatus !== 'needs_human' && !state.finished) await store.append('root/finish', { status: finalStatus as RootTerminalStatus, reportRef })
      } catch (error) {
        failureDetail ??= formatError(error)
      }
    }
    await store.close().catch(() => {})
  }
  return { rootId, status: finalStatus, directory, baseCommit, ...(integrationBranch ? { integrationBranch } : {}), ...(reportRef ? { reportRef } : {}), ...(failureDetail ? { error: failureDetail } : {}) }
}
