import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createLogRecordParser } from '../core/event-store.js'
import {
  changedFilesBetween, cherryPick, cherryPickAbort, cherryPickInProgress, findCommitByTrailer,
  headCommit, resetHard, treeOf,
} from './git.js'
import type { GitRunOptions } from './git.js'
import { collectAndCommit, findScopeViolations } from './integrator.js'
import type { HumanRequestData, PlanInput } from './contracts.js'
import type { OrchestrationStore } from './store.js'
import { foldOrchestration } from './state.js'
import type { AttemptState, OrchestrationState } from './state.js'
import type { WorktreeManager } from './worktrees.js'

// 只读读取 worker/planner 会话的已确认前缀：尾部半行与首个损坏记录之后的内容不参与判断。
export interface SessionSummary {
  completed: boolean
  runStatus?: string
  unknownToolResult: boolean
  bashStarted: boolean
}
export async function readSessionSummary(sessionDirectory: string, sessionId: string): Promise<SessionSummary | undefined> {
  const file = path.join(sessionDirectory, sessionId, 'events.jsonl')
  const text = await fs.readFile(file, 'utf8').catch(() => undefined)
  if (text === undefined) return undefined
  const lines = text.split('\n')
  if (!text.endsWith('\n')) lines.pop()
  if (!lines.length) return undefined
  const parse = createLogRecordParser(sessionId)
  const started = new Map<string, string>(), finished = new Set<string>()
  let completed = false, runStatus: string | undefined, unknownToolResult = false
  for (const line of lines) {
    if (!line) continue
    let event: import('../core/contracts.js').SessionEvent
    try { event = parse(line) } catch { break }
    if (event.type === 'run/start') runStatus = 'running'
    else if (event.type === 'run/finish') { runStatus = event.data.state.status; completed = event.data.state.status === 'completed' }
    else if (event.type === 'tool/start') started.set(event.data.toolCallId, event.data.name)
    else if (event.type === 'tool/result') {
      finished.add(event.data.toolCallId)
      if (event.data.status === 'unknown') unknownToolResult = true
    }
  }
  const bashStarted = [...started].some(([toolCallId, name]) => name === 'bash' && !finished.has(toolCallId))
  return { completed, ...(runStatus ? { runStatus } : {}), unknownToolResult, bashStarted }
}

// cherry-pick 进行到一半：先中止，回到 integration/started 的基线，再按 applied 记录重放。
export async function recoverOpenIntegration(input: {
  store: OrchestrationStore
  manager: WorktreeManager
  state: OrchestrationState
  signal?: AbortSignal
}) {
  const integration = input.state.integration
  if (!integration || integration.status !== 'started') return undefined
  const opened = await input.manager.ensureIntegration(integration.baseCommit)
  const options: GitRunOptions = input.signal ? { signal: input.signal } : {}
  if (await cherryPickInProgress(opened.path)) await cherryPickAbort(opened.path)
  await resetHard(opened.path, integration.baseCommit)
  for (const applied of integration.applied) {
    const picked = await cherryPick(opened.path, applied.sourceCommit, options)
    if (!picked.ok) {
      await cherryPickAbort(opened.path)
      throw new Error(`cannot replay integrated attempt ${applied.attemptId}; integration branch needs manual inspection`)
    }
  }
  const head = await headCommit(opened.path), tree = await treeOf(opened.path, head)
  await input.store.append('integration/finished', { integrationId: integration.integrationId, head, tree })
  return { head, tree }
}

function subtaskWriteSet(plan: PlanInput, subtaskId: string) {
  return plan.subtasks.find(item => item.id === subtaskId)?.writeSet ?? []
}

async function attemptCommit(repository: string, attempt: AttemptState) {
  if (!attempt.branch) return undefined
  return findCommitByTrailer(repository, attempt.branch, attempt.attemptId).catch(() => undefined)
}

async function adoptAttempt(input: {
  store: OrchestrationStore
  repository: string
  rootId: string
  attempt: AttemptState
  plan: PlanInput
  signal?: AbortSignal
}) {
  const { attempt } = input
  const writeSet = subtaskWriteSet(input.plan, attempt.subtaskId)
  const commit = await attemptCommit(input.repository, attempt)
  if (commit) {
    const changedFiles = (await changedFilesBetween(input.repository, attempt.baseCommit, commit)).map(item => item.replace(/\\/g, '/'))
    const scopeViolations = findScopeViolations(changedFiles, writeSet)
    const outcome = scopeViolations.length ? 'scope_violation' : changedFiles.length ? 'succeeded' : 'no_changes'
    await input.store.append('attempt/finished', {
      attemptId: attempt.attemptId, outcome,
      run: { ...(attempt.sessionId ? { sessionId: attempt.sessionId } : {}), status: 'completed' },
      code: {
        commit, tree: await treeOf(input.repository, commit), changedFiles, scopeViolations,
      },
      detail: 'adopted a completed worker commit after recovery',
    })
    return outcome
  }
  if (!attempt.worktree || !(await fs.stat(attempt.worktree).catch(() => undefined))) return undefined
  try {
    const collected = await collectAndCommit({
      worktree: attempt.worktree, baseCommit: attempt.baseCommit, writeSet, rootId: input.rootId,
      attemptId: attempt.attemptId, subtaskId: attempt.subtaskId,
      ...(input.signal ? { signal: input.signal } : {}),
    })
    await input.store.append('attempt/finished', {
      attemptId: attempt.attemptId, outcome: collected.outcome,
      run: { ...(attempt.sessionId ? { sessionId: attempt.sessionId } : {}), status: 'completed' },
      code: {
        ...(collected.commit ? { commit: collected.commit } : {}), ...(collected.tree ? { tree: collected.tree } : {}),
        changedFiles: collected.changedFiles, scopeViolations: collected.scopeViolations,
      },
      detail: 'adopted a completed worker run from its worktree after recovery',
    })
    return collected.outcome
  } catch {
    return undefined
  }
}

export interface ReconcileResult { retry: Set<string>; pending: HumanRequestData[] }
// 对账 §8.4 的崩溃窗口：已完成的 run 采用结果，未完成的标记 interrupted；
// 有未知副作用的 attempt 生成人工请求，没有未知副作用的允许自动重试一次（受 attempt 上限约束）。
export async function reconcileAttempts(input: {
  store: OrchestrationStore
  manager: WorktreeManager
  repository: string
  rootId: string
  plan: PlanInput
  state: OrchestrationState
  retry: Set<string>
  signal?: AbortSignal
}): Promise<ReconcileResult> {
  const retry = new Set(input.retry)
  const pending: HumanRequestData[] = []
  let state = input.state
  const load = async () => { state = foldOrchestration(await input.store.read()) }
  const attemptsFor = (subtaskId: string) => state.attemptOrder.map(id => state.attempts[id]!).filter(item => item.subtaskId === subtaskId)
  // 已有人工决定优先于重新询问：retry 表示用户已同意重跑，abandon 表示放弃，
  // pending 表示请求仍在等待，不能重复生成。
  const decideInterrupted = async (attempt: AttemptState, unknownSideEffects: boolean) => {
    const related = Object.values(state.human).filter(item => item.request.attemptId === attempt.attemptId)
    const choice = related.find(item => item.response)?.response?.choice
    if (choice === 'retry' || retry.has(attempt.subtaskId)) { retry.add(attempt.subtaskId); return }
    if (choice === 'abandon') return
    if (related.some(item => !item.response)) return
    if (unknownSideEffects) {
      const request: HumanRequestData = {
        requestId: `hr_${randomUUID()}`, kind: 'unknown_side_effects', attemptId: attempt.attemptId,
        prompt: `${attempt.subtaskId} 的执行被中断，可能存在未确认的外部副作用。`,
        options: ['retry', 'abandon'],
      }
      await input.store.append('human/requested', request)
      pending.push(request)
      await load()
      return
    }
    if (attemptsFor(attempt.subtaskId).length < state.config.maxAttemptsPerSubtask) retry.add(attempt.subtaskId)
  }
  for (const attemptId of [...state.attemptOrder]) {
    const attempt = state.attempts[attemptId]!
    if (attempt.status === 'interrupted') {
      await decideInterrupted(attempt, Boolean(attempt.unknownSideEffects))
      continue
    }
    if (!['starting', 'running'].includes(attempt.status)) continue
    const summary = attempt.sessionDirectory && attempt.sessionId
      ? await readSessionSummary(attempt.sessionDirectory, attempt.sessionId)
      : undefined
    if (summary?.completed) {
      const adopted = await adoptAttempt({ store: input.store, repository: input.repository, rootId: input.rootId, attempt, plan: input.plan, ...(input.signal ? { signal: input.signal } : {}) })
      if (adopted !== undefined) { await load(); continue }
      await input.store.append('attempt/finished', {
        attemptId, outcome: 'run_failed',
        run: { ...(attempt.sessionId ? { sessionId: attempt.sessionId } : {}), status: 'completed' },
        code: { changedFiles: [], scopeViolations: [] },
        detail: 'completed run could not be collected after recovery; inspect the worktree manually',
      })
      await load()
      continue
    }
    const unknownSideEffects = summary
      ? summary.unknownToolResult || summary.bashStarted
      : attempt.status === 'running'
    await input.store.append('attempt/finished', {
      attemptId, outcome: 'interrupted',
      run: {
        ...(attempt.sessionId ? { sessionId: attempt.sessionId } : {}),
        status: summary?.runStatus ?? 'interrupted',
      },
      code: { changedFiles: [], scopeViolations: [] },
      unknownSideEffects,
      detail: summary ? 'worker did not finish before the process stopped' : 'no readable worker session after the process stopped',
    })
    await load()
    await decideInterrupted(attempt, unknownSideEffects)
  }
  return { retry, pending }
}

export interface ResolvedHumans { retry: Set<string>; remaining: HumanRequestData[] }
// resume --retry/--skip 也是人工决定的入口：对应的 pending 请求先落 human/resolved，再继续执行。
export async function resolvePendingHumans(input: {
  store: OrchestrationStore
  state: OrchestrationState
  acceptUnknownUsage: boolean
  retry: ReadonlySet<string>
  skip: ReadonlySet<string>
}): Promise<ResolvedHumans> {
  const retry = new Set(input.retry)
  let state = input.state
  for (const human of Object.values(state.human)) {
    if (human.response) continue
    const request = human.request
    const subtaskId = request.attemptId ? state.attempts[request.attemptId]?.subtaskId : undefined
    let choice: string | undefined
    if (request.kind === 'budget_extension' && input.acceptUnknownUsage) choice = 'accept-unknown-usage'
    else if (request.kind === 'unknown_side_effects' && subtaskId) {
      if (input.skip.has(subtaskId)) choice = 'abandon'
      else if (input.retry.has(subtaskId)) choice = 'retry'
    } else if (request.kind === 'conflict' && subtaskId) {
      if (input.skip.has(subtaskId)) choice = 'skip-subtask'
      else if (input.retry.has(subtaskId)) choice = 'rerun-serially'
    }
    if (!choice) continue
    await input.store.append('human/resolved', { requestId: request.requestId, choice, actor: 'local-user' })
    if ((choice === 'retry' || choice === 'rerun-serially') && subtaskId) retry.add(subtaskId)
    state = foldOrchestration(await input.store.read())
  }
  const remaining = Object.values(state.human).filter(item => !item.response).map(item => item.request)
  return { retry, remaining }
}

export function blockingUnknownUsage(state: OrchestrationState) {
  return Object.values(state.ledger.reservations).some(item => item.status === 'unknown' && item.cause !== 'cancel')
}

export function pendingHumanRequests(state: OrchestrationState) {
  return Object.values(state.human).filter(item => !item.response).map(item => item.request)
}
