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
}
export const CLI_BUDGET: Readonly<BudgetPolicy> = Object.freeze({
  maxModelRequests: 64, maxToolCalls: 128, maxActiveDurationMs: 600_000,
  maxTotalTokens: 2_000_000, maxOutputTokens: 16_384, minimumOutputTokens: 4_096,
  inputTargetTokens: 65_536, safetyMarginTokens: 2_048,
  requestTimeoutMs: 180_000, approvalTimeoutMs: 300_000,
})
const positive = new Set(['maxOutputTokens', 'minimumOutputTokens', 'contextWindowTokens', 'inputTargetTokens', 'requestTimeoutMs', 'approvalTimeoutMs'])
const keys = new Set(Object.keys(CLI_BUDGET).concat('contextWindowTokens'))
export function resolveBudget(...layers: (BudgetPolicy | undefined)[]): Readonly<BudgetPolicy> {
  const result: BudgetPolicy = {}
  for (const layer of layers) {
    if (layer === undefined) continue
    if (!layer || typeof layer !== 'object' || Array.isArray(layer)) throw new Error('budget must be an object')
    for (const [key, value] of Object.entries(layer)) {
      if (!keys.has(key)) throw new Error(`unknown budget key: ${key}`)
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (positive.has(key) ? 1 : 0)) {
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
export interface Counters { modelRequests: number; toolCalls: number; inputTokens: number; outputTokens: number; totalTokens: number; activeDurationMs: number }
export const emptyCounters = (): Counters => ({ modelRequests: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, activeDurationMs: 0 })
export interface RunState {
  sessionId: string; taskId: string; runId: string; model: string
  policy: Readonly<BudgetPolicy>; counters: Counters; status: 'running' | StopReason
  usage: Usage[]; removedTaskIds: string[]; estimatedInputTokens?: number
}
export class BudgetStop extends Error {
  constructor(public reason: Exclude<StopReason, 'completed'>, public state?: RunState) {
    super(`Agent run ${reason}`)
    this.name = 'BudgetStop'
  }
}
