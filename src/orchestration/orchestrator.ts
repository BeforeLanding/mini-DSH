import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { utf8Prefix } from '../core/tool-result-store.js'
import { TaskGroupBudgetCoordinator } from '../core/task-group-budget.js'
import type { ApprovalRequest } from '../core/contracts.js'
import type { CommandOptions, CommandResult } from '../core/command-runner.js'
import type { HarnessAdapter } from '../app/create-harness.js'
import type { AttemptBudget, AttemptOutcome, PlanInput, RootBudget, RootStatus } from './contracts.js'
import { assertPlanInput } from './validation.js'
import { newRootId, OrchestrationStore, orchestrationDirectory, writeArtifact } from './store.js'
import { OrchestrationGroupJournal } from './group-journal.js'
import { foldOrchestration, orchestrationTotals } from './state.js'
import { repositoryRoot } from './git.js'
import { attemptBranch, integrationBranchName, WorktreeManager } from './worktrees.js'
import { runWorker } from './worker.js'
import type { WorkerAssignment, WorkerOutcome } from './worker.js'
import { collectAndCommit, integrateAttempts } from './integrator.js'
import { verifyIntegration } from './verifier.js'

export const DEFAULT_ROOT_BUDGET: Readonly<RootBudget> = Object.freeze({
  maxModelRequests: 96, maxTotalTokens: 2_000_000, maxWallMs: 1_800_000, maxToolCalls: 256,
  plannerShare: 0.1, fixReserveTokens: 200_000, maxInFlightRequests: 2,
})
export const DEFAULT_WORKER_BUDGET: Readonly<AttemptBudget> = Object.freeze({ maxModelRequests: 32, maxToolCalls: 64, maxTotalTokens: 1_000_000 })
const ROOT_BUDGET_KEYS = new Set(['maxModelRequests', 'maxTotalTokens', 'maxWallMs', 'maxToolCalls', 'plannerShare', 'fixReserveTokens', 'maxInFlightRequests', 'maxUsd'])
const BUDGET_STOPS = new Set(['max_steps', 'max_tool_calls', 'token_budget', 'timeout', 'request_timeout', 'approval_timeout', 'context_overflow', 'output_limit'])
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
  approve?: (request: ApprovalRequest) => Promise<boolean>
}
export interface OrchestrateOptions {
  repository: string
  goal: string
  plan: PlanInput
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
function preparePlan(plan: PlanInput, maxSubtasks: number) {
  assertPlanInput(plan)
  if (plan.subtasks.length > maxSubtasks) throw new Error(`plan exceeds maxSubtasks (${maxSubtasks})`)
  for (const subtask of plan.subtasks) for (const entry of subtask.writeSet) {
    const target = entry.endsWith('/') ? entry.slice(0, -1) : entry
    if (target === '.git' || target.startsWith('.git/') || target === '.mini-dsh' || target.startsWith('.mini-dsh/')) throw new Error(`write set may not target protected path: ${entry}`)
  }
  if (plan.subtasks.length !== 1) throw new Error('M1 executes exactly one subtask per plan; parallel waves land in M2')
  return plan
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
function formatError(error: unknown) { return bounded(error instanceof Error ? error.message : String(error), 1024) }
export async function orchestrate(options: OrchestrateOptions): Promise<OrchestrateResult> {
  const progress = options.onProgress ?? (() => {})
  const maxWorkers = options.maxWorkers ?? 2, maxSubtasks = options.maxSubtasks ?? 4, maxAttemptsPerSubtask = options.maxAttemptsPerSubtask ?? 2
  if (!Number.isSafeInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 4) throw new Error('maxWorkers must be 1..4')
  if (!Number.isSafeInteger(maxSubtasks) || maxSubtasks < 1 || maxSubtasks > 6) throw new Error('maxSubtasks must be 1..6')
  if (!Number.isSafeInteger(maxAttemptsPerSubtask) || maxAttemptsPerSubtask < 1 || maxAttemptsPerSubtask > 8) throw new Error('maxAttemptsPerSubtask must be 1..8')
  const budget = resolveRootBudget(options.rootBudget, maxWorkers)
  const plan = preparePlan(options.plan, maxSubtasks)
  const repository = await repositoryRoot(options.repository)
  const rootId = newRootId()
  const directory = orchestrationDirectory(options.baseDirectory, rootId)
  const manager = new WorktreeManager(repository, rootId, directory, { ...(options.prepareCommand ? { prepareCommand: options.prepareCommand } : {}), ...(options.signal ? { signal: options.signal } : {}) })
  const clean = await manager.assertClean({ allowDirty: options.allowDirty })
  const baseCommit = clean.baseCommit
  const store = await OrchestrationStore.open(directory, rootId)
  const approval = options.approval ?? { writes: 'auto', bash: 'ask' }
  const approve = async (request: ApprovalRequest) => {
    const automatic = request.tool === 'write_file' || request.tool === 'edit_file'
      ? approval.writes === 'auto' : request.tool === 'bash' ? approval.bash === 'auto' : false
    if (automatic) return true
    return approval.approve ? approval.approve(request) : false
  }
  const subtask = plan.subtasks[0]!
  const attemptBudget = allocateBudget(budget, options.workerBudget)
  let finalStatus: RootStatus = 'failed', reportRef: string | undefined, integrationBranch: string | undefined
  let failureDetail: string | undefined
  const rootData = { goal: bounded(options.goal, 4096), repository, baseCommit, config: { mode: options.mode ?? 'auto' as const, maxWorkers, maxSubtasks, maxAttemptsPerSubtask }, budget }
  try {
    await store.append('root/start', rootData)
    progress(`root ${rootId} @ ${baseCommit}`)
    await store.append('plan/recorded', {
      planId: `pl_${randomUUID()}`, planVersion: 1, source: 'file', plan,
      validation: { ok: true, waves: [[subtask.id]] },
    })
    await store.append('plan/decision', { planVersion: 1, mode: 'single', reason: 'M1 single-attempt path', waves: [[subtask.id]] })
    const group = await TaskGroupBudgetCoordinator.openJournal(new OrchestrationGroupJournal(store), {
      maxModelRequests: budget.maxModelRequests, maxToolCalls: budget.maxToolCalls, maxTotalTokens: budget.maxTotalTokens,
      rootTokenFloor: 0, rootRequestFloor: 0, maxWallDurationMs: budget.maxWallMs,
    }, options.clock ?? Date.now)
    const attemptId = `at_${randomUUID()}`
    const branch = attemptBranch(rootId, subtask.id, 1)
    const worktree = manager.layout.attempt(attemptId)
    const sessionDirectory = path.join(manager.layout.root, 'sessions', attemptId)
    await store.append('attempt/planned', { attemptId, subtaskId: subtask.id, epoch: 1, wave: 0, baseCommit, budget: attemptBudget })
    await store.append('attempt/started', { attemptId, worktree, branch, sessionDirectory })
    progress(`attempt ${attemptId} on ${branch}`)
    let outcome: WorkerOutcome | undefined
    let classification: AttemptOutcome = 'failed'
    let code: { commit?: string; tree?: string; changedFiles: string[]; scopeViolations: string[] } = { changedFiles: [], scopeViolations: [] }
    let runStatus = 'setup_failed', stopReason: string | undefined
    try {
      await manager.createAttempt({ attemptId, subtaskId: subtask.id, epoch: 1, baseCommit })
      await manager.prepare(worktree)
      const signal = options.signal ? AbortSignal.any([group.signal, options.signal]) : group.signal
      const assignment: WorkerAssignment = {
        rootGoal: options.goal, subtaskId: subtask.id, title: subtask.title, objective: subtask.objective,
        writeSet: subtask.writeSet, readHints: subtask.readHints ?? [], acceptance: subtask.acceptance,
        ...(plan.sharedNotes ? { sharedNotes: plan.sharedNotes } : {}), baseCommit, planVersion: 1,
      }
      outcome = await runWorker({
        assignment, rootId, attemptId, worktree, layout: manager.layout, adapter: options.adapter,
        model: options.model ?? `${options.adapter.provider}/${options.adapter.model}`, rootGroup: group,
        budget: attemptBudget, signal, approve, onSession: async sessionId => { await store.append('attempt/session', { attemptId, sessionId }) },
        ...(options.commandRunner ? { commandRunner: options.commandRunner } : {}),
      })
      runStatus = outcome.runStatus
      stopReason = outcome.stopReason
      if (runStatus !== 'completed') classification = runStatus === 'cancelled' ? 'cancelled' : BUDGET_STOPS.has(runStatus) ? 'budget_stopped' : 'run_failed'
      else if (outcome.report.valid && outcome.report.status !== 'done') classification = 'needs_input'
      else {
        const collected = await collectAndCommit({ worktree, baseCommit, writeSet: subtask.writeSet, rootId, attemptId, subtaskId: subtask.id, ...(options.signal ? { signal: options.signal } : {}) })
        classification = collected.outcome
        code = { ...(collected.commit ? { commit: collected.commit } : {}), ...(collected.tree ? { tree: collected.tree } : {}), changedFiles: collected.changedFiles, scopeViolations: collected.scopeViolations }
      }
      const artifact = await writeArtifact(path.join(store.directory, 'artifacts'), {
        assignment: { subtaskId: subtask.id, title: subtask.title, objective: subtask.objective, writeSet: subtask.writeSet },
        run: { status: runStatus, stopReason }, report: outcome.report, usage: outcome.usage,
        final: bounded(outcome.finalContent, 16 * 1024), ...(outcome.error ? { error: outcome.error } : {}), code,
      }).catch(() => undefined)
      await store.append('attempt/finished', {
        attemptId, outcome: classification,
        run: { sessionId: outcome.sessionId, status: runStatus, ...(stopReason ? { stopReason } : {}) },
        code, ...(artifact ? { resultRef: artifact.ref } : {}),
        ...(classification === 'needs_input' && outcome.report.summary ? { detail: bounded(outcome.report.summary, 1024) } : {}),
      })
      progress(`attempt ${attemptId} ${classification}`)
      if (classification === 'succeeded') {
        const applied = await integrateAttempts({
          store, manager, baseCommit, wave: 0,
          attempts: [{ attemptId, subtaskId: subtask.id, commit: code.commit! }],
          ...(options.signal ? { signal: options.signal } : {}),
        })
        if (applied.status === 'blocked') {
          await store.append('human/requested', {
            requestId: `hr_${randomUUID()}`, kind: 'conflict', attemptId,
            prompt: `${subtask.id} 与已整合内容冲突：${applied.conflict.files.join(', ')}。`,
            options: ['rerun-serially', 'skip-subtask', 'abort'],
          })
          finalStatus = 'needs_human'
        } else {
          integrationBranch = integrationBranchName(rootId)
          progress(`integration ${applied.head}`)
          const verification = await verifyIntegration({
            store, worktree: manager.layout.integration, head: applied.head!, tree: applied.tree!,
            commands: [...subtask.acceptance.commands, ...(options.verifyCommands ?? [])],
            ...(options.signal ? { signal: options.signal } : {}),
          })
          progress(`verification ${verification.passed ? 'passed' : 'failed'}`)
          finalStatus = verification.passed ? 'completed' : 'failed'
          if (!verification.passed) failureDetail = 'integrated verification failed'
        }
      } else {
        finalStatus = 'failed'
        failureDetail = classification === 'needs_input' ? (outcome.report.summary || 'worker requested input') : `attempt ${classification}`
      }
    } catch (error) {
      failureDetail = formatError(error)
      runStatus = 'error'
      if (!outcome) {
        try {
          await store.append('attempt/finished', { attemptId, outcome: 'failed', run: { status: runStatus }, code: { changedFiles: [], scopeViolations: [] }, detail: failureDetail })
        } catch { /* the outer root/finish attempt reports the failure */ }
      }
      finalStatus = 'failed'
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
        integration: state.integration, verifications: state.verifications, ledger: orchestrationTotals(state),
        dirtyBaseline: clean.dirty > 0, paths: { directory, worktrees: manager.layout.worktrees, sessions: path.join(directory, 'sessions') },
      }
      reportRef = (await writeArtifact(path.join(store.directory, 'artifacts'), report)).ref
      if (finalStatus !== 'needs_human' && !state.finished) await store.append('root/finish', { status: finalStatus, reportRef })
    } catch (error) {
      failureDetail ??= formatError(error)
    } finally {
      await store.close().catch(() => {})
    }
  }
  return { rootId, status: finalStatus, directory, baseCommit, ...(integrationBranch ? { integrationBranch } : {}), ...(reportRef ? { reportRef } : {}), ...(failureDetail ? { error: failureDetail } : {}) }
}
