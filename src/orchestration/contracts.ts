import type { Usage } from '../core/budget.js'
import type { GroupReservation, GroupStart } from '../core/task-group-budget.js'

// 编排日志是根任务唯一的事实来源（DEVELOPMENT.md §4.6、§8）。会话事件契约不变：
// 这里的类型只描述编排日志自己的信封与负载。

export type RootTerminalStatus = 'completed' | 'partial' | 'failed' | 'cancelled' | 'budget_exhausted'
export type RootStatus = 'planning' | 'running' | 'integrating' | 'verifying' | 'needs_human' | RootTerminalStatus
export type AttemptOutcome = 'succeeded' | 'no_changes' | 'scope_violation' | 'budget_stopped' | 'run_failed' | 'needs_input' | 'interrupted' | 'failed' | 'cancelled' | 'skipped'

export interface RootBudget {
  maxModelRequests: number
  maxTotalTokens: number
  maxWallMs: number
  maxToolCalls: number
  plannerShare: number
  fixReserveTokens: number
  maxInFlightRequests: number
  maxUsd?: number
}

export interface OrchestrationConfig {
  mode: 'auto' | 'single' | 'parallel'
  maxWorkers: number
  maxSubtasks: number
  maxAttemptsPerSubtask: number
}

export interface RootStart {
  goal: string
  repository: string
  baseCommit: string
  config: OrchestrationConfig
  budget: RootBudget
}

export interface SubtaskAcceptance { commands: string[] }

export interface SubtaskSpec {
  id: string
  title: string
  objective: string
  writeSet: string[]
  readHints?: string[]
  dependsOn?: string[]
  acceptance: SubtaskAcceptance
}

export interface PlanInput {
  version: 1
  rationale: string
  sharedNotes?: string
  subtasks: SubtaskSpec[]
}

export type PlanValidation = { ok: true; waves: string[][] } | { ok: false; errors: string[] }

export interface PlanRecorded {
  planId: string
  planVersion: number
  source: 'file' | 'model'
  plannerSessionId?: string
  plan: PlanInput
  validation: PlanValidation
}

export interface PlanDecision {
  planVersion: number
  mode: 'single' | 'parallel'
  reason: string
  waves: string[][]
}

export interface AttemptBudget { maxModelRequests: number; maxToolCalls: number; maxTotalTokens: number }

export interface AttemptPlanned {
  attemptId: string
  subtaskId: string
  epoch: number
  wave: number
  baseCommit: string
  budget: AttemptBudget
}

export interface AttemptStarted { attemptId: string; worktree: string; branch: string; sessionDirectory: string }
export interface AttemptSession { attemptId: string; sessionId: string }
export interface AttemptFinished {
  attemptId: string
  outcome: AttemptOutcome
  run: { sessionId?: string; status: string; stopReason?: string }
  code: { commit?: string; tree?: string; changedFiles: string[]; scopeViolations: string[] }
  resultRef?: string
  summary?: string
  detail?: string
  // 中断时的外部副作用风险：会话里出现过 status=unknown 的工具结果，或 Bash 已开始但未收尾。
  unknownSideEffects?: boolean
}
export interface AttemptLate { attemptId: string; summary: string; epoch?: number }

export interface IntegrationStarted { integrationId: string; wave: number; baseCommit: string }
export interface IntegrationApplied { integrationId: string; attemptId: string; sourceCommit: string; commit: string }
export interface IntegrationConflict { integrationId: string; attemptId: string; files: string[] }
export interface IntegrationFinished { integrationId: string; head: string; tree: string }
export interface VerificationFinished { head: string; tree: string; command: string; exitCode: number | null; logRef?: string }

export type HumanRequestKind = 'approval' | 'conflict' | 'unknown_side_effects' | 'budget_extension' | 'question'
export interface HumanRequestData {
  requestId: string
  kind: HumanRequestKind
  prompt: string
  options: string[]
  attemptId?: string
}
export interface HumanResolvedData { requestId: string; choice: string; note?: string; actor: 'local-user' }
export interface ApprovalRequestedData { requestId: string; attemptId: string; tool: string; summaryHash: string; writeSet?: string[] }
export interface ApprovalResolvedData { requestId: string; attemptId: string; tool: string; allowed: boolean; source: 'auto' | 'user' | 'timeout' | 'cancelled' }
export interface ControlStop { scope: 'accepting' | 'dispatch' | 'running'; reason: string }
export interface RootFinish { status: RootTerminalStatus; reportRef?: string }

// 预算事件沿用 M0 协调器的 group/* 命名与负载（§4.6 预算事件说明）：
// 同一份状态机既服务会话日志，也服务编排日志，不维护第二套命名。
export type OrchEventData = {
  'root/start': RootStart
  'plan/recorded': PlanRecorded
  'plan/decision': PlanDecision
  'attempt/planned': AttemptPlanned
  'attempt/started': AttemptStarted
  'attempt/session': AttemptSession
  'attempt/finished': AttemptFinished
  'attempt/late': AttemptLate
  'integration/started': IntegrationStarted
  'integration/applied': IntegrationApplied
  'integration/conflict': IntegrationConflict
  'integration/finished': IntegrationFinished
  'verification/finished': VerificationFinished
  'human/requested': HumanRequestData
  'human/resolved': HumanResolvedData
  'approval/requested': ApprovalRequestedData
  'approval/resolved': ApprovalResolvedData
  'control/stop': ControlStop
  'root/finish': RootFinish
  'group/start': GroupStart
  'group/budget-reserved': GroupReservation & { groupId: string }
  'group/model-dispatched': { groupId: string; requestId: string }
  'group/reservation-released': { groupId: string; requestId: string }
  'group/usage-unknown': { groupId: string; requestId: string; cause?: 'crash' | 'cancel' | 'no_usage' }
  'group/budget-settled': { groupId: string; requestId: string; usage: Usage; overrun: boolean }
  'group/tool-admitted': { groupId: string; key: string; agentId: string; sessionId: string; runId: string; toolCallId: string }
}

export type OrchEventType = keyof OrchEventData
export interface OrchestrationEvent<K extends OrchEventType = OrchEventType> {
  v: 1
  rootId: string
  seq: number
  id: string
  at: string
  type: K
  data: OrchEventData[K]
}
// 折叠与读取面对的是「某个具体事件」的联合，而不是 type/data 分别取并集的对象；
// 前者才能让 switch 逐支收窄。
export type OrchestrationEventUnion = { [K in OrchEventType]: OrchestrationEvent<K> }[OrchEventType]
