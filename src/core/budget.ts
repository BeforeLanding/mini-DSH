export interface BudgetPolicy {
  maxModelRequests?: number
  maxToolCalls?: number
  maxActiveDurationMs?: number
  maxTotalTokens?: number
  maxOutputTokens?: number
  minimumOutputTokens?: number
  contextWindowTokens?: number
  inputTargetTokens?: number
  safetyMarginTokens?: number
  requestTimeoutMs?: number
  approvalTimeoutMs?: number
  finalizationTimeoutMs?: number
  // NX-34 上下文压缩。compactionBudgetTokens 刻意**不**进 CLI_BUDGET：它的默认值是 inputTargetTokens，
  // 写死成 65,536 会让调整输入目标时压缩阈值不再跟着走。
  compactionBudgetTokens?: number
  compactionRatio?: number
  retainRatio?: number
  compactionMaxTokens?: number
  maxSummaryFailures?: number
  maxOverflowRetries?: number
  auto?: boolean
}
export const CLI_BUDGET: Readonly<BudgetPolicy> = Object.freeze({
  maxModelRequests: 64, maxToolCalls: 128, maxActiveDurationMs: 600_000,
  maxTotalTokens: 2_000_000, maxOutputTokens: 16_384, minimumOutputTokens: 4_096,
  inputTargetTokens: 65_536, safetyMarginTokens: 2_048,
  requestTimeoutMs: 180_000, approvalTimeoutMs: 300_000,
  finalizationTimeoutMs: 5_000,
  compactionRatio: 0.8, retainRatio: 0.16, compactionMaxTokens: 8_192,
  maxSummaryFailures: 2, maxOverflowRetries: 1, auto: true,
})
const positive = new Set(['maxOutputTokens', 'minimumOutputTokens', 'contextWindowTokens', 'inputTargetTokens', 'requestTimeoutMs', 'approvalTimeoutMs', 'finalizationTimeoutMs', 'compactionBudgetTokens', 'compactionMaxTokens'])
// 比率与开关不是安全整数，单独放行——但只放行这两个集合里的键，其余仍走整数判定。
// 压缩比率落在 0 < v ≤ 1：0 会让阈值恒为真，超过 1 则永远触发不了，两者都不是比率。
const fractions = new Set(['compactionRatio', 'retainRatio'])
const booleans = new Set(['auto'])
const keys = new Set(Object.keys(CLI_BUDGET).concat('contextWindowTokens', 'compactionBudgetTokens'))
export function resolveBudget(...layers: (BudgetPolicy | undefined)[]): Readonly<BudgetPolicy> {
  const result: BudgetPolicy = {}
  for (const layer of layers) {
    if (layer === undefined) continue
    if (!layer || typeof layer !== 'object' || Array.isArray(layer)) throw new Error('budget must be an object')
    for (const [key, value] of Object.entries(layer)) {
      if (!keys.has(key)) throw new Error(`unknown budget key: ${key}`)
      if (booleans.has(key)) {
        if (typeof value !== 'boolean') throw new Error(`invalid budget ${key}: expected a boolean`)
      } else if (fractions.has(key)) {
        if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) throw new Error(`invalid budget ${key}: expected a fraction in (0, 1]`)
      } else if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (positive.has(key) ? 1 : 0)) {
        throw new Error(`invalid budget ${key}: expected ${positive.has(key) ? 'positive' : 'nonnegative'} safe integer`)
      }
      Object.assign(result, { [key]: value })
    }
  }
  if (result.minimumOutputTokens !== undefined && result.maxOutputTokens !== undefined && result.minimumOutputTokens > result.maxOutputTokens) throw new Error('minimumOutputTokens exceeds maxOutputTokens')
  if (result.inputTargetTokens !== undefined && result.contextWindowTokens === undefined) throw new Error('context capacity must be explicitly configured')
  if (result.contextWindowTokens !== undefined && result.maxOutputTokens === undefined) throw new Error('context capacity requires maxOutputTokens')
  return Object.freeze(result)
}
export type StopReason = 'completed' | 'max_steps' | 'max_tool_calls' | 'timeout' | 'token_budget' | 'context_overflow' | 'cancelled' | 'error' | 'approval_timeout' | 'request_timeout' | 'output_limit'
export interface Usage { inputTokens: number; outputTokens: number; totalTokens: number; source: 'provider' | 'estimated'; uncertain: boolean; reasoningTokens?: number }
export interface Counters { modelRequests: number; toolCalls: number; inputTokens: number; outputTokens: number; totalTokens: number; activeDurationMs: number; approvalDurationMs: number }
export const emptyCounters = (): Counters => ({ modelRequests: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, activeDurationMs: 0, approvalDurationMs: 0 })
export interface RunState {
  sessionId: string; taskId: string; runId: string; previousRunId?: string; model: string
  policy: Readonly<BudgetPolicy>; counters: Counters; status: 'running' | StopReason
  usage: Usage[]; removedTaskIds: string[]; estimatedInputTokens?: number
  terminalCommit?: { status: 'confirmed' | 'uncertain'; terminalStatus: StopReason; activeDurationMs: number }
  // NX-34：维护型 run（`/compact`）。它复用当前 task 但不承接工作，因此不进续跑链。
  maintenance?: boolean
}
export class BudgetStop extends Error {
  constructor(public reason: Exclude<StopReason, 'completed'>, public state?: RunState) {
    super(`Agent run ${reason}`)
    this.name = 'BudgetStop'
  }
}
