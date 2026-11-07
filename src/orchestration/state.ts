import type { Usage } from '../core/budget.js'
import type { GroupReservation, TaskGroupPolicy } from '../core/task-group-budget.js'
import type {
  ApprovalRequestedData, ApprovalResolvedData, AttemptBudget, AttemptOutcome, HumanRequestData, HumanResolvedData,
  IntegrationApplied, OrchestrationConfig, OrchestrationEventUnion, PlanDecision, PlanRecorded, RootBudget, RootStatus,
} from './contracts.js'

export type AttemptStatus = 'planned' | 'starting' | 'running' | 'finished' | 'cancelled' | 'interrupted' | 'skipped' | 'failed'

export interface AttemptState {
  attemptId: string
  subtaskId: string
  epoch: number
  wave: number
  baseCommit: string
  budget: AttemptBudget
  status: AttemptStatus
  worktree?: string
  branch?: string
  sessionDirectory?: string
  sessionId?: string
  outcome?: AttemptOutcome
  runStatus?: string
  stopReason?: string
  commit?: string
  tree?: string
  changedFiles: string[]
  scopeViolations: string[]
  resultRef?: string
  summary?: string
  detail?: string
}

export interface LedgerReservation extends GroupReservation {
  groupId: string
  status: 'reserved' | 'dispatched' | 'released' | 'settled' | 'unknown'
  usage?: Usage
}

export interface LedgerState {
  groupId?: string
  deadline?: number
  policy?: TaskGroupPolicy
  reservations: Record<string, LedgerReservation>
  tools: string[]
}

export interface IntegrationState {
  integrationId: string
  wave: number
  baseCommit: string
  status: 'started' | 'finished' | 'blocked'
  head?: string
  tree?: string
  applied: IntegrationApplied[]
  conflicts: { attemptId: string; files: string[] }[]
}

export interface VerificationState { head: string; tree: string; command: string; exitCode: number | null; logRef?: string }
export interface HumanState { request: HumanRequestData; response?: HumanResolvedData }
export interface ApprovalState { request: ApprovalRequestedData; response?: ApprovalResolvedData }

export interface OrchestrationState {
  rootId: string
  goal: string
  repository: string
  baseCommit: string
  config: OrchestrationConfig
  budget: RootBudget
  status: RootStatus
  stop: { dispatch: boolean; running: boolean; reason?: string }
  plan?: PlanRecorded
  decision?: PlanDecision
  attempts: Record<string, AttemptState>
  attemptOrder: string[]
  ledger: LedgerState
  integration?: IntegrationState
  // 每个波次一个整合周期；completed 判定看全部周期的并集，最终验收只绑定最后一个周期的 tree。
  integrations: IntegrationState[]
  verifications: VerificationState[]
  human: Record<string, HumanState>
  approvals: Record<string, ApprovalState>
  finished?: { status: RootStatus; reportRef?: string }
}

const TERMINAL: ReadonlySet<AttemptStatus> = new Set(['finished', 'cancelled', 'interrupted', 'skipped', 'failed'])
const outcomeStatus = (outcome: AttemptOutcome): AttemptStatus =>
  outcome === 'interrupted' ? 'interrupted' : outcome === 'cancelled' ? 'cancelled' : outcome === 'skipped' ? 'skipped' : outcome === 'failed' ? 'failed' : 'finished'
const sameWave = (left: string[][], right: string[][]) => left.length === right.length && left.every((wave, index) => wave.length === right[index]!.length && wave.every((id, position) => id === right[index]![position]))

// 状态折叠是纯函数：只读取日志，不产生副作用；所有非法迁移在这里拒绝。
export function foldOrchestration(events: readonly OrchestrationEventUnion[]): OrchestrationState {
  if (!events.length || events[0]!.type !== 'root/start') throw new Error('orchestration log must begin with root/start')
  const root = events[0]!.data
  const state: OrchestrationState = {
    rootId: events[0]!.rootId, goal: root.goal, repository: root.repository, baseCommit: root.baseCommit,
    config: structuredClone(root.config), budget: structuredClone(root.budget), status: 'planning',
    stop: { dispatch: false, running: false }, attempts: {}, attemptOrder: [],
    ledger: { reservations: {}, tools: [] }, integrations: [], verifications: [], human: {}, approvals: {},
  }
  const ids = new Set<string>()
  for (const [index, event] of events.entries()) {
    if (event.rootId !== state.rootId) throw new Error('orchestration log mixes root tasks')
    if (event.seq !== index + 1) throw new Error('orchestration sequence mismatch')
    if (ids.has(event.id)) throw new Error('duplicate orchestration event id')
    ids.add(event.id)
    if (index === 0) continue
    if (state.finished && event.type !== 'attempt/late') throw new Error(`event ${event.type} after root/finish`)
    foldEvent(state, event)
  }
  return state
}

function foldEvent(state: OrchestrationState, event: OrchestrationEventUnion) {
  switch (event.type) {
    case 'root/start': throw new Error('duplicate root/start')
    case 'plan/recorded': {
      if (state.status !== 'planning') throw new Error('plan can only be recorded while planning')
      const data = event.data
      if (state.plan && data.planVersion !== state.plan.planVersion + 1) throw new Error('plan version must increase by one')
      if (!state.plan && data.planVersion !== 1) throw new Error('first plan version must be 1')
      state.plan = structuredClone(data)
      return
    }
    case 'plan/decision': {
      if (!state.plan) throw new Error('plan/decision requires a recorded plan')
      if (!state.plan.validation.ok) throw new Error('plan/decision requires a valid plan')
      if (state.decision) throw new Error('duplicate plan/decision')
      if (state.plan.planVersion !== event.data.planVersion) throw new Error('plan/decision version mismatch')
      if (!sameWave(state.plan.validation.waves, event.data.waves)) throw new Error('plan/decision waves do not match validation')
      state.decision = structuredClone(event.data)
      state.status = 'running'
      return
    }
    case 'attempt/planned': {
      if (!state.decision) throw new Error('attempt requires a plan decision')
      const data = event.data
      if (state.attempts[data.attemptId]) throw new Error('duplicate attempt id')
      if (data.wave >= state.decision.waves.length) throw new Error('attempt wave is outside the plan')
      if (!state.decision.waves[data.wave]!.includes(data.subtaskId)) throw new Error('attempt subtask is not in its wave')
      const existing = state.attemptOrder.filter(id => state.attempts[id]!.subtaskId === data.subtaskId).length
      if (data.epoch !== existing + 1) throw new Error('attempt epoch must increase by one')
      if (data.epoch > state.config.maxAttemptsPerSubtask) throw new Error('attempt exceeds maxAttemptsPerSubtask')
      state.attempts[data.attemptId] = { ...structuredClone(data), status: 'planned', changedFiles: [], scopeViolations: [] }
      state.attemptOrder.push(data.attemptId)
      return
    }
    case 'attempt/started': {
      const attempt = requireAttempt(state, event.data.attemptId)
      if (attempt.status !== 'planned') throw new Error('attempt can only start from planned')
      attempt.status = 'starting'
      attempt.worktree = event.data.worktree
      attempt.branch = event.data.branch
      attempt.sessionDirectory = event.data.sessionDirectory
      return
    }
    case 'attempt/session': {
      const attempt = requireAttempt(state, event.data.attemptId)
      if (attempt.status !== 'starting') throw new Error('attempt session requires a started attempt')
      if (attempt.sessionId && attempt.sessionId !== event.data.sessionId) throw new Error('attempt session is fixed')
      attempt.sessionId = event.data.sessionId
      attempt.status = 'running'
      return
    }
    case 'attempt/finished': {
      const attempt = requireAttempt(state, event.data.attemptId)
      if (!['planned', 'starting', 'running'].includes(attempt.status)) throw new Error('attempt already reached a terminal state')
      const data = event.data
      attempt.status = outcomeStatus(data.outcome)
      attempt.outcome = data.outcome
      attempt.runStatus = data.run.status
      attempt.stopReason = data.run.stopReason
      attempt.commit = data.code.commit
      attempt.tree = data.code.tree
      attempt.changedFiles = [...data.code.changedFiles]
      attempt.scopeViolations = [...data.code.scopeViolations]
      attempt.resultRef = data.resultRef
      attempt.summary = data.summary
      attempt.detail = data.detail
      return
    }
    case 'attempt/late': {
      const attempt = requireAttempt(state, event.data.attemptId)
      if (!TERMINAL.has(attempt.status)) throw new Error('late attempt result requires a terminal attempt')
      return
    }
    case 'group/start': {
      if (state.ledger.groupId) throw new Error('duplicate task group')
      state.ledger.groupId = event.data.groupId
      state.ledger.deadline = event.data.deadline
      state.ledger.policy = structuredClone(event.data.policy)
      return
    }
    case 'group/budget-reserved': {
      requireGroup(state, event.data.groupId)
      if (state.ledger.reservations[event.data.requestId]) throw new Error('duplicate group reservation')
      state.ledger.reservations[event.data.requestId] = { ...structuredClone(event.data), status: 'reserved' }
      return
    }
    case 'group/model-dispatched': case 'group/reservation-released': case 'group/usage-unknown': case 'group/budget-settled': {
      requireGroup(state, event.data.groupId)
      const reservation = state.ledger.reservations[event.data.requestId]
      if (!reservation) throw new Error('missing group reservation')
      if (event.type === 'group/model-dispatched') {
        if (reservation.status !== 'reserved') throw new Error('invalid group dispatch transition')
        reservation.status = 'dispatched'
      } else if (event.type === 'group/reservation-released') {
        if (!['reserved', 'dispatched'].includes(reservation.status)) throw new Error('invalid group release transition')
        reservation.status = 'released'
      } else if (event.type === 'group/usage-unknown') {
        if (reservation.status !== 'dispatched') throw new Error('invalid group unknown transition')
        reservation.status = 'unknown'
      } else {
        if (reservation.status !== 'dispatched') throw new Error('invalid group settlement transition')
        if (event.data.overrun !== (event.data.usage.totalTokens > reservation.reserve)) throw new Error('group settlement overrun mismatch')
        reservation.status = 'settled'
        reservation.usage = structuredClone(event.data.usage)
      }
      return
    }
    case 'group/tool-admitted': {
      requireGroup(state, event.data.groupId)
      if (state.ledger.tools.includes(event.data.key)) throw new Error('duplicate group tool admission')
      state.ledger.tools.push(event.data.key)
      return
    }
    case 'integration/started': {
      if (state.integration && state.integration.status === 'started') throw new Error('integration already in progress')
      if (!state.decision || event.data.wave >= state.decision.waves.length) throw new Error('integration wave is outside the plan')
      const integration: IntegrationState = { ...structuredClone(event.data), status: 'started', applied: [], conflicts: [] }
      state.integrations.push(integration)
      state.integration = integration
      state.status = 'integrating'
      return
    }
    case 'integration/applied': {
      const integration = requireOpenIntegration(state, event.data.integrationId)
      const attempt = requireAttempt(state, event.data.attemptId)
      if (attempt.outcome !== 'succeeded' || attempt.commit !== event.data.sourceCommit) throw new Error('only a succeeded attempt commit can be integrated')
      if (integration.applied.some(item => item.attemptId === event.data.attemptId)) throw new Error('attempt is already integrated')
      integration.applied.push(structuredClone(event.data))
      return
    }
    case 'integration/conflict': {
      const integration = requireOpenIntegration(state, event.data.integrationId)
      requireAttempt(state, event.data.attemptId)
      if (integration.conflicts.some(item => item.attemptId === event.data.attemptId)) throw new Error('duplicate integration conflict')
      integration.conflicts.push({ attemptId: event.data.attemptId, files: [...event.data.files] })
      integration.status = 'blocked'
      state.status = 'needs_human'
      return
    }
    case 'integration/finished': {
      const integration = requireOpenIntegration(state, event.data.integrationId)
      if (integration.conflicts.length) throw new Error('conflicted integration cannot finish')
      integration.status = 'finished'
      integration.head = event.data.head
      integration.tree = event.data.tree
      state.status = state.decision && integration.wave + 1 < state.decision.waves.length ? 'running' : 'verifying'
      return
    }
    case 'verification/finished': {
      const integration = state.integration
      if (integration?.status !== 'finished') throw new Error('verification requires a finished integration')
      if (event.data.head !== integration.head || event.data.tree !== integration.tree) throw new Error('verification evidence is not bound to the integration tree')
      if (state.verifications.some(item => item.tree === event.data.tree && item.command === event.data.command)) throw new Error('duplicate verification evidence')
      state.verifications.push(structuredClone(event.data))
      state.status = 'verifying'
      return
    }
    case 'human/requested': {
      if (state.human[event.data.requestId]) throw new Error('duplicate human request')
      state.human[event.data.requestId] = { request: structuredClone(event.data) }
      state.status = 'needs_human'
      return
    }
    case 'human/resolved': {
      const human = state.human[event.data.requestId]
      if (!human) throw new Error('unknown human request')
      if (human.response) throw new Error('human request already resolved')
      human.response = structuredClone(event.data)
      return
    }
    case 'approval/requested': {
      requireAttempt(state, event.data.attemptId)
      if (state.approvals[event.data.requestId]) throw new Error('duplicate approval request')
      state.approvals[event.data.requestId] = { request: structuredClone(event.data) }
      return
    }
    case 'approval/resolved': {
      const approval = state.approvals[event.data.requestId]
      if (!approval) throw new Error('unknown approval request')
      if (approval.response) throw new Error('approval request already resolved')
      if (approval.request.attemptId !== event.data.attemptId) throw new Error('approval attempt mismatch')
      approval.response = structuredClone(event.data)
      return
    }
    case 'control/stop': {
      if (event.data.scope === 'running') state.stop.running = true
      if (event.data.scope === 'running' || event.data.scope === 'dispatch') state.stop.dispatch = true
      state.stop.reason = event.data.reason
      return
    }
    case 'root/finish': {
      if (state.finished) throw new Error('duplicate root/finish')
      const data = event.data
      if (data.status === 'completed') {
        if (!state.decision || state.integration?.status !== 'finished') throw new Error('completed root requires a finished integration')
        if (!state.verifications.length || state.verifications.some(item => item.exitCode !== 0)) throw new Error('completed root requires passing verification evidence')
        const applied = new Set(state.integrations.flatMap(item => item.applied.map(appliedItem => appliedItem.attemptId)))
        const subtasks = state.decision.waves.flat()
        if (!subtasks.every(id => state.attemptOrder.some(attemptId => { const attempt = state.attempts[attemptId]!; return attempt.subtaskId === id && attempt.outcome === 'succeeded' && applied.has(attemptId) }))) throw new Error('completed root requires every subtask integrated')
      }
      if (data.status === 'partial') {
        if (state.integration?.status !== 'finished') throw new Error('partial root requires a finished integration')
        if (!state.verifications.length || state.verifications.some(item => item.exitCode !== 0)) throw new Error('partial root requires passing evidence for the integrated part')
      }
      state.finished = { status: data.status, reportRef: data.reportRef }
      state.status = data.status
      return
    }
    default: throw new Error('unknown orchestration event type')
  }
}

function requireAttempt(state: OrchestrationState, attemptId: string) {
  const attempt = state.attempts[attemptId]
  if (!attempt) throw new Error('unknown attempt')
  return attempt
}
function requireGroup(state: OrchestrationState, groupId: string) {
  if (state.ledger.groupId !== groupId) throw new Error('unknown or cross-root task group')
}
function requireOpenIntegration(state: OrchestrationState, integrationId: string) {
  const integration = state.integration
  if (!integration || integration.integrationId !== integrationId) throw new Error('unknown integration')
  if (integration.status !== 'started') throw new Error('integration is not open')
  return integration
}

export function orchestrationTotals(state: OrchestrationState) {
  let requests = 0, providerTokens = 0, estimatedTokens = 0, unknownChargedTokens = 0, outstandingTokens = 0, cacheReadTokens = 0
  for (const reservation of Object.values(state.ledger.reservations)) {
    if (reservation.status === 'released') continue
    requests++
    if (reservation.status === 'settled' && reservation.usage) {
      if (reservation.usage.source === 'provider') providerTokens += reservation.usage.totalTokens
      else estimatedTokens += reservation.usage.totalTokens
      cacheReadTokens += reservation.usage.cacheReadTokens ?? 0
    } else if (reservation.status === 'unknown') unknownChargedTokens += reservation.reserve
    else outstandingTokens += reservation.reserve
  }
  return { requests, providerTokens, estimatedTokens, unknownChargedTokens, outstandingTokens, cacheReadTokens }
}
