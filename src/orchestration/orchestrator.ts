import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { utf8Prefix } from '../core/tool-result-store.js'
import { TaskGroupBudgetCoordinator } from '../core/task-group-budget.js'
import { CLI_BUDGET } from '../core/budget.js'
import type { ApprovalRequest } from '../core/contracts.js'
import type { CommandOptions, CommandResult } from '../core/command-runner.js'
import type { HarnessAdapter } from '../app/create-harness.js'
import type { AttemptBudget, AttemptOutcome, PlanInput, RootBudget, RootStatus, SubtaskSpec } from './contracts.js'
import { DEFAULT_PROTECTED_PATHS, validatePlan } from './plan.js'
import { planInputError } from './validation.js'
import { newRootId, OrchestrationStore, orchestrationDirectory, writeArtifact } from './store.js'
import { OrchestrationGroupJournal } from './group-journal.js'
import { foldOrchestration, orchestrationTotals } from './state.js'
import type { OrchestrationState } from './state.js'
import { repositoryRoot } from './git.js'
import { attemptBranch, integrationBranchName, WorktreeManager } from './worktrees.js'
import { runWorker } from './worker.js'
import type { WorkerAssignment, WorkerOutcome } from './worker.js'
import { applyAttempt, collectAndCommit, finishIntegration, openIntegration } from './integrator.js'
import { verifyIntegration } from './verifier.js'
import { runPlanner } from './planner.js'
import { ApprovalBroker } from './approval-broker.js'

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
export interface OrchestrateOptions {
  repository: string
  goal: string
  // 缺省时由只读 planner 生成计划；提供时以计划文件为准。
  plan?: PlanInput
  baseDirectory: string
  adapter: HarnessAdapter
  model?: string
  mode?: 'auto' | 'single' | 'parallel'
  maxWorkers?: number
  maxSubtasks?: number
  maxAttemptsPerSubtask?: number
  rootBudget?: Partial<RootBudget>
  workerBudget?: Partial<AttemptBudget>
  prepareCommand?: string
  verifyCommands?: string[]
  allowDirty?: boolean
  approval?: ApprovalPolicy
  commandRunner?: (options: CommandOptions) => Promise<CommandResult>
  signal?: AbortSignal
  clock?: () => number
  onProgress?: (line: string) => void
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
// 简单并发池：最多 limit 个 worker 同时运行；某个 attempt 结束后再补位。
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
  await Promise.all(runners)
  return results
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
  const approval = options.approval ?? { writes: 'auto', bash: 'ask' }
  const perRequestTimeoutMs = approval.perRequestTimeoutMs ?? CLI_BUDGET.approvalTimeoutMs ?? 300_000
  const writeSets = new Map<string, string[]>()
  // 审批审计事件只追加、不参与恢复；事件写入失败不影响工具得到的审批决定。
  const broker = new ApprovalBroker({
    policy: { writes: approval.writes, bash: approval.bash, perRequestTimeoutMs },
    ...(approval.approve ? { prompt: approval.approve } : {}),
    writeSetFor: attemptId => writeSets.get(attemptId),
    onRequested: async data => { await store.append('approval/requested', data) },
    onResolved: async data => { await store.append('approval/resolved', data) },
  })
  const model = options.model ?? `${options.adapter.provider}/${options.adapter.model}`
  const protectedPaths = DEFAULT_PROTECTED_PATHS
  let finalStatus: RootStatus = 'failed', reportRef: string | undefined, integrationBranch: string | undefined
  let failureDetail: string | undefined
  let currentHead = baseCommit, integrationPath: string | undefined
  const integrated = new Set<string>()
  const rootData = { goal: bounded(options.goal, 4096), repository, baseCommit, config: { mode: options.mode ?? 'auto' as const, maxWorkers, maxSubtasks, maxAttemptsPerSubtask }, budget }
  try {
    await store.append('root/start', rootData)
    progress(`root ${rootId} @ ${baseCommit}`)
    const group = await TaskGroupBudgetCoordinator.openJournal(new OrchestrationGroupJournal(store), {
      maxModelRequests: budget.maxModelRequests, maxToolCalls: budget.maxToolCalls, maxTotalTokens: budget.maxTotalTokens,
      rootTokenFloor: 0, rootRequestFloor: 0, maxWallDurationMs: budget.maxWallMs, maxInFlightRequests: budget.maxInFlightRequests,
    }, options.clock ?? Date.now)
    const signal = options.signal ? AbortSignal.any([group.signal, options.signal]) : group.signal
    // 规划：计划文件优先；没有文件时由只读 planner 在基线快照中提出计划。
    let plan = options.plan
    let planSource: 'file' | 'model' = 'file'
    let plannerSessionId: string | undefined
    if (!plan) {
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
    const decision = validation.decision
    await store.append('plan/decision', { planVersion: 1, mode: decision.mode, reason: decision.reason, waves: decision.waves })
    progress(`plan ${decision.mode}: ${decision.reason}`)
    const executeAttempt = async (input: { subtask: SubtaskSpec; wave: number; epoch: number; baseCommit: string; budget: AttemptBudget; state: OrchestrationState }): Promise<AttemptResult> => {
      const attemptId = `at_${randomUUID()}`, branch = attemptBranch(rootId, input.subtask.id, input.epoch)
      const worktree = manager.layout.attempt(attemptId)
      const sessionDirectory = path.join(manager.layout.root, 'sessions', attemptId)
      await store.append('attempt/planned', { attemptId, subtaskId: input.subtask.id, epoch: input.epoch, wave: input.wave, baseCommit: input.baseCommit, budget: input.budget })
      await store.append('attempt/started', { attemptId, worktree, branch, sessionDirectory })
      writeSets.set(attemptId, [...input.subtask.writeSet])
      progress(`attempt ${attemptId} ${input.subtask.id} epoch=${input.epoch} on ${branch}`)
      let outcome: WorkerOutcome | undefined
      let classification: AttemptOutcome = 'failed', runStatus = 'setup_failed', stopReason: string | undefined
      let code: CollectedCode = { changedFiles: [], scopeViolations: [] }
      let summary: string | undefined, detail: string | undefined
      let recorded = false
      try {
        await manager.createAttempt({ attemptId, subtaskId: input.subtask.id, epoch: input.epoch, baseCommit: input.baseCommit })
        await manager.prepare(worktree)
        const dependencies = taskDependencies(input.state, input.subtask)
        const assignment: WorkerAssignment = {
          rootGoal: options.goal, subtaskId: input.subtask.id, title: input.subtask.title, objective: input.subtask.objective,
          writeSet: input.subtask.writeSet, readHints: input.subtask.readHints ?? [], acceptance: input.subtask.acceptance,
          ...(selectedPlan.sharedNotes ? { sharedNotes: selectedPlan.sharedNotes } : {}), baseCommit: input.baseCommit, planVersion: 1,
          ...(dependencies.length ? { dependencies } : {}),
        }
        outcome = await runWorker({
          assignment, rootId, attemptId, worktree, layout: manager.layout, adapter: options.adapter, model, rootGroup: group,
          budget: input.budget, signal, approve: request => broker.request(attemptId, request),
          approvalTimeoutMs: perRequestTimeoutMs * (maxWorkers + 1),
          onSession: async sessionId => { await store.append('attempt/session', { attemptId, sessionId }) },
          ...(options.commandRunner ? { commandRunner: options.commandRunner } : {}),
        })
        runStatus = outcome.runStatus
        stopReason = outcome.stopReason
        if (runStatus !== 'completed') classification = runStatus === 'cancelled' ? 'cancelled' : BUDGET_STOPS.has(runStatus) ? 'budget_stopped' : 'run_failed'
        else if (outcome.report.valid && outcome.report.status !== 'done') classification = 'needs_input'
        else {
          const collected = await collectAndCommit({
            worktree, baseCommit: input.baseCommit, writeSet: input.subtask.writeSet, rootId, attemptId, subtaskId: input.subtask.id,
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
      } catch (error) {
        detail = formatError(error)
        classification = 'failed'
        if (!recorded) {
          try { await store.append('attempt/finished', { attemptId, outcome: 'failed', run: { status: 'error' }, code: { changedFiles: [], scopeViolations: [] }, detail }) } catch { /* the root report carries the failure */ }
        }
      } finally {
        broker.cancelAttempt(attemptId)
      }
      return {
        attemptId, subtaskId: input.subtask.id, wave: input.wave, epoch: input.epoch, outcome: classification,
        ...(code.commit ? { commit: code.commit } : {}), ...(code.tree ? { tree: code.tree } : {}),
        changedFiles: code.changedFiles, scopeViolations: code.scopeViolations,
        ...(summary ? { summary } : {}), ...(detail ? { detail } : {}), ...(outcome?.sessionId ? { sessionId: outcome.sessionId } : {}), runStatus,
      }
    }
    const skippedAttempt = async (subtask: SubtaskSpec, wave: number, reason: string) => {
      const state = foldOrchestration(await store.read())
      const epoch = epochFor(state, subtask.id)
      if (epoch > maxAttemptsPerSubtask) return
      const attemptId = `at_${randomUUID()}`
      await store.append('attempt/planned', { attemptId, subtaskId: subtask.id, epoch, wave, baseCommit: currentHead, budget: { maxModelRequests: 1, maxToolCalls: 1, maxTotalTokens: 1 } })
      await store.append('attempt/finished', { attemptId, outcome: 'skipped', run: { status: 'skipped' }, code: { changedFiles: [], scopeViolations: [] }, detail: bounded(reason, 1024) })
      progress(`attempt ${attemptId} ${subtask.id} skipped: ${reason}`)
    }
    outer: for (const [waveIndex, waveIds] of decision.waves.entries()) {
      const state = foldOrchestration(await store.read())
      const runnable: SubtaskSpec[] = []
      for (const subtaskId of waveIds) {
        if (integrated.has(subtaskId) || hasTerminalAttempt(state, subtaskId)) continue
        const subtask = selectedPlan.subtasks.find(item => item.id === subtaskId)!
        if (dependenciesIntegrated(subtask, integrated)) runnable.push(subtask)
        else await skippedAttempt(subtask, waveIndex, `dependencies are not integrated: ${(subtask.dependsOn ?? []).filter(id => !integrated.has(id)).join(', ')}`)
      }
      if (!runnable.length) continue
      const waveBase = currentHead
      const allocation = waveBudget(budget, state, runnable.length, options.workerBudget)
      progress(`wave ${waveIndex + 1}/${decision.waves.length}: ${runnable.map(item => item.id).join(', ')} (${decision.mode})`)
      const results = await pool(runnable, decision.mode === 'parallel' ? maxWorkers : 1, subtask => executeAttempt({
        subtask, wave: waveIndex, epoch: epochFor(state, subtask.id), baseCommit: waveBase, budget: allocation, state,
      }))
      const order = new Map(waveIds.map((id, index) => [id, index]))
      const successes = results.filter(result => result.outcome === 'succeeded' && result.commit).sort((a, b) => order.get(a.subtaskId)! - order.get(b.subtaskId)!)
      if (!successes.length) continue
      const opened = await openIntegration({ store, manager, wave: waveIndex, baseCommit: currentHead, ...(options.signal ? { signal: options.signal } : {}) })
      integrationPath = opened.path
      for (const result of successes) {
        const applied = await applyAttempt({
          store, integrationId: opened.integrationId, path: opened.path,
          attempt: { attemptId: result.attemptId, subtaskId: result.subtaskId, commit: result.commit! },
          ...(options.signal ? { signal: options.signal } : {}),
        })
        if (applied.status === 'conflict') {
          await store.append('human/requested', {
            requestId: `hr_${randomUUID()}`, kind: 'conflict', attemptId: result.attemptId,
            prompt: `${result.subtaskId} 与已整合内容冲突：${applied.conflict.files.join(', ')}。`,
            options: ['rerun-serially', 'skip-subtask', 'abort'],
          })
          finalStatus = 'needs_human'
          progress(`integration conflict on ${result.subtaskId}: ${applied.conflict.files.join(', ')}`)
          break outer
        }
        integrated.add(result.subtaskId)
      }
      const finished = await finishIntegration({ store, integrationId: opened.integrationId, path: opened.path })
      currentHead = finished.head
      integrationBranch = integrationBranchName(rootId)
      progress(`integration wave ${waveIndex + 1} ${finished.head}`)
    }
    const state = foldOrchestration(await store.read())
    if (state.integration?.status === 'finished' && integrationPath && state.integration.head && state.integration.tree) {
      const commands = new Set<string>()
      for (const subtaskId of integrated) {
        const subtask = selectedPlan.subtasks.find(item => item.id === subtaskId)
        for (const command of subtask?.acceptance.commands ?? []) commands.add(command)
      }
      for (const command of options.verifyCommands ?? []) commands.add(command)
      const verification = await verifyIntegration({
        store, worktree: integrationPath, head: state.integration.head, tree: state.integration.tree,
        commands: [...commands], ...(options.signal ? { signal: options.signal } : {}),
      })
      progress(`verification ${verification.passed ? 'passed' : 'failed'}`)
      const complete = decision.waves.flat().every(id => integrated.has(id))
      if (!verification.passed) { finalStatus = 'failed'; failureDetail = 'integrated verification failed' }
      else if (complete) finalStatus = 'completed'
      else if (integrated.size > 0) finalStatus = 'partial'
      else { finalStatus = 'failed'; failureDetail = 'no subtask was integrated' }
    } else {
      finalStatus = 'failed'
      failureDetail ??= 'no attempt produced an integrable change'
    }
  } catch (error) {
    failureDetail = formatError(error)
    finalStatus = 'failed'
  } finally {
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
      if (finalStatus !== 'needs_human' && !state.finished) await store.append('root/finish', { status: finalStatus, reportRef })
    } catch (error) {
      failureDetail ??= formatError(error)
    } finally {
      await broker.close().catch(() => {})
      await store.close().catch(() => {})
    }
  }
  return { rootId, status: finalStatus, directory, baseCommit, ...(integrationBranch ? { integrationBranch } : {}), ...(reportRef ? { reportRef } : {}), ...(failureDetail ? { error: failureDetail } : {}) }
}
