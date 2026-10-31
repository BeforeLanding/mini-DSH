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
  postCompactionTargetRatio?: number
  retainRatio?: number
  compactionMaxTokens?: number
  maxSummaryFailures?: number
  maxOverflowRetries?: number
  tokenCalibration?: boolean
  tokenCalibrationMaxMultiplier?: number
  auto?: boolean
  // NX-51：压力摘要后按压缩后目标线裁掉已结束旧任务。24 条真实对照未显示摘要/耗时下降，
  // 因此**默认关闭**；显式设为 true 才启用，裁剪决定仍以 context/prune 事件持久化。
  postCompactionPrune?: boolean
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
const fractions = new Set(['compactionRatio', 'retainRatio', 'postCompactionTargetRatio'])
const booleans = new Set(['auto', 'tokenCalibration', 'postCompactionPrune'])
const keys = new Set(Object.keys(CLI_BUDGET).concat('contextWindowTokens', 'compactionBudgetTokens', 'postCompactionTargetRatio', 'tokenCalibration', 'tokenCalibrationMaxMultiplier', 'postCompactionPrune'))
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
      } else if (key === 'tokenCalibrationMaxMultiplier') {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || value > 10) throw new Error(`invalid budget ${key}: expected a finite number in [1, 10]`)
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
// NX-39 新增 cacheReadTokens：DeepSeek 的 usage 里一直带着 prompt_cache_hit_tokens，此前被
// normalizeUsage 丢掉，于是「命中缓存的部分」只能按无命中估算。它是**成本**口径的量，不影响能力——
// 前缀缓存纪律那条对照（见 PLAN 的提示优化维度）靠它才可判。缺省不写（undefined）与 provider 明确
// 报 0 是两回事：前者是没有这个字段的 provider，后者是真的没命中。
export interface Usage { inputTokens: number; outputTokens: number; totalTokens: number; source: 'provider' | 'estimated'; uncertain: boolean; reasoningTokens?: number; cacheReadTokens?: number }
// NX-39 新增 toolErrors 与 cacheReadTokens。toolErrors 此前只以 tool/result 的 isError 形态存在于事件里，
// 没有任何聚合——报告要归因「失败是模型没做出来还是工具本身在报错」就得手工数事件。两者都从事件派生
// （见 session-runtime.ts 的 #foldLatestRun），与 toolCalls/modelRequests 同一条路径，因此续跑与恢复
// 折叠出来的值一致。逐请求延迟**不在这里**：它由 eval 侧从 model/start→model/end 的 at 时间戳现算，
// 属于评测视图而不是运行时状态。
// NX-39 又增 previewTruncations：工具结果的**预览**被截断的次数。它是「工具输出有界」这一半的触发率
// 来源——有界档下超限结果被换成头尾预览并落盘（带回 ref），无界档下同一条结果逐字进历史。没有它，
// 「关掉有界掉 0 分」这句话在账面上无法与「有界根本没生效」区分开（预注册的必须报的量）。
// 名字里写明 preview：`command.stdout.truncated` 是命令采集本身的上限，两件事不能同名。
export interface Counters { modelRequests: number; toolCalls: number; toolErrors: number; previewTruncations: number; inputTokens: number; outputTokens: number; totalTokens: number; cacheReadTokens: number; activeDurationMs: number; approvalDurationMs: number }
export const emptyCounters = (): Counters => ({ modelRequests: 0, toolCalls: 0, toolErrors: 0, previewTruncations: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, activeDurationMs: 0, approvalDurationMs: 0 })
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
