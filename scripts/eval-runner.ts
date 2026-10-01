import { CLI_BUDGET } from '../src/core/budget.js'
import type { BudgetPolicy, Counters, StopReason } from '../src/core/budget.js'

// PLAN「NX-08 评测批次上限（预注册）」固定的参数。请求数 32 是约束（两臂获得相同工作量，被比较的才是
// 上下文策略而不是预算）；token 2000000 是兜底（正常 fixture 任务不应触及，否则预算耗尽会混进所测用量）。
export const singleRunBudget: Readonly<BudgetPolicy> = Object.freeze({
  maxModelRequests: 32, maxToolCalls: 64, maxActiveDurationMs: 300_000, maxTotalTokens: 2_000_000,
})
// 预注册只覆盖上面四项，其余必须走 PLAN「默认参数与行为」的文档值（输入目标 65,536、输出上限 16,384、
// 输出预留下限 4,096、容量余量 2,048、请求/审批/收尾超时）。只用 singleRunBudget 会让投影拿不到
// inputTargetTokens 与 contextWindowTokens：ContextBudgetRuntime 对两者均未配置时恒判 fits，裁剪与
// context_overflow 全部失效，A/B 两臂的上下文差异也随之归零。
export const evalPolicy: Readonly<BudgetPolicy> = Object.freeze({ ...CLI_BUDGET, ...singleRunBudget })
export type PhaseName = 'screening' | 'armA' | 'armB'
export interface BatchCaps { runs: number; requests: number; tokens: number }
export const phaseCaps: Readonly<Record<PhaseName, BatchCaps>> = Object.freeze({
  screening: { runs: 12, requests: 400, tokens: 8_000_000 },
  armA: { runs: 72, requests: 2_400, tokens: 45_000_000 },
  armB: { runs: 72, requests: 2_400, tokens: 45_000_000 },
})
export const batchCaps: Readonly<BatchCaps> = Object.freeze({ runs: 156, requests: 5_200, tokens: 98_000_000 })
export const capKeys = ['runs', 'requests', 'tokens'] as const

// 单次 run 预算与整批上限的优先关系：单次预算由 Agent 循环在 run 内强制，触顶只停止该次 run 并给出停止
// 原因，该 run 仍计入阶段；整批上限由本运行器在每次 run 之前与之后检查阶段累计值，触顶中止整个阶段并
// 报告。因此一个已经开始的 run 不会被整批上限中途终止，触顶时的超出量以单次 run 的用量为上界。
// 独立验收的原始结论：passed 是唯一判定，其余字段是失败案例所需的证据（退出码、验收输出、被改动的
// 受保护文件）。报告必须能解释某次失败是模型没做出来，还是验收环境本身出了问题。
export interface AcceptanceDetail {
  passed: boolean
  exitCode: number | null
  output: string
  protectedFilesChanged: string[]
}
// 一个 fixture 可以是一个任务，也可以是同一会话内按序下发的多个阶段任务（见 coding-fixtures.ts 的
// readTaskSequence）。RunOutcome 描述整次 fixture 运行：status 取最后一个阶段，counters 是各阶段之和，
// 验收仍是工作区终态一次判定；逐阶段的观测留在 tasks 里，用于定位是哪个阶段把预算或上下文用光。
// NX-08e2 起还带逐阶段的投影观测：判断“第几个阶段开始触发裁剪”靠的是这些字段，counters 看不出来。
// estimatedInputTokens 是该阶段最后一次投影的值，也是裁剪后的值——裁剪一开始，它就钉在输入目标附近，
// 因此它只说明“当时有多大”，不代表该阶段自身的增长；裁剪前的规模只能由相邻阶段的投影外推。
export interface RunTaskDetail {
  taskId: string
  status: StopReason | 'running'
  counters: Counters
  estimatedInputTokens?: number
  maxEstimatedInputTokens?: number
  // 该阶段的投影次数与第几次投影首次裁剪（1 起；null 表示该阶段从未裁剪）。
  projections: number
  firstPrunedProjection: number | null
  removedTaskIds: string[]
  // 已记录投影但没有对应 model/start：该请求在发出前被 context_overflow 或 token 预算拦下。
  unsentProjections: number
  // provider 与 estimated 分列（R-21 要求报告给出这一区分），按使用条目数计。
  usageSources: { provider: number; estimated: number }
}
export interface RunOutcome {
  status: StopReason | 'running'
  counters: Counters
  accepted: boolean | null
  acceptance?: AcceptanceDetail
  tasks?: RunTaskDetail[]
  // 任务按规格不可解（fixture 或 Harness 缺陷，而非模型能力）。只影响成功率分母的口径，必须由人来判定
  // 并在报告中给出理由；没有证据就不设该字段。
  infeasible?: boolean
  error?: string
}
export interface RunRecord<T> extends RunOutcome { task: T }
export interface PhaseAbort { cap: typeof capKeys[number]; limit: number; observed: number }
export interface PhaseTotals { runs: number; requests: number; tokens: number }
export interface PhaseReport<T> {
  phase: PhaseName
  planned: number
  executed: RunRecord<T>[]
  aborted: PhaseAbort | null
  totals: PhaseTotals
}

function overCap(totals: PhaseTotals, caps: BatchCaps, crossed: boolean): PhaseAbort | null {
  for (const cap of capKeys) {
    if (crossed ? totals[cap] > caps[cap] : totals[cap] >= caps[cap]) return { cap, limit: caps[cap], observed: totals[cap] }
  }
  return null
}

// 阶段内串行执行：整批上限是累计量，并发会让触顶时的已执行集合不确定。
// classify 用于在 run 结束后判定“任务按规格不可解”；它只能追加这一标记，不能改写已观测的验收结论。
export async function runPhase<T>(phase: PhaseName, planned: readonly T[], caps: BatchCaps, execute: (task: T) => Promise<RunOutcome>,
  classify?: (record: RunRecord<T>) => { infeasible?: boolean } | undefined): Promise<PhaseReport<T>> {
  const executed: RunRecord<T>[] = []
  const totals = { runs: 0, requests: 0, tokens: 0 }
  let aborted: PhaseAbort | null = null
  for (const task of planned) {
    // 开跑前先看余额，避免启动一个已经超额的 run；此处用 >=，使上限恰好等于计划数时不会误报中止。
    const exhausted = overCap(totals, caps, false)
    if (exhausted) { aborted = exhausted; break }
    let outcome: RunOutcome
    try {
      outcome = await execute(task)
    } catch (error) {
      // 单次执行失败记在该 run 上并继续，不中止阶段：中止只由整批上限触发，否则会掩盖其余任务的证据。
      outcome = { status: 'error', counters: { modelRequests: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, activeDurationMs: 0, approvalDurationMs: 0 }, accepted: null, error: error instanceof Error ? error.message : String(error) }
    }
    const record: RunRecord<T> = { ...outcome, task }
    if (classify?.(record)?.infeasible) record.infeasible = true
    executed.push(record)
    totals.runs += 1
    totals.requests += outcome.counters.modelRequests
    totals.tokens += outcome.counters.totalTokens
    const crossed = overCap(totals, caps, true)
    if (crossed) { aborted = crossed; break }
  }
  return { phase, planned: planned.length, executed, aborted, totals }
}

// 阶段中止不是任务失败：已执行的 run 保留各自的真实状态与验收结论，中止只说明剩余 run 未执行。
// accepted/rejected 是原始计数；rate 是成功率口径——分子只数通过验收的 run，分母排除不可行任务与
// 基础设施失败（两者都单列，不能静默丢掉，否则“少跑了几个”会被读成“模型失败率下降了”）。
export function summarize<T>(report: PhaseReport<T>) {
  const executed = report.executed
  const infeasible = executed.filter(run => run.infeasible).length
  const errored = executed.filter(run => !run.infeasible && run.error !== undefined).length
  const rateable = executed.filter(run => !run.infeasible && run.error === undefined)
  const numerator = rateable.filter(run => run.accepted === true).length
  return {
    phase: report.phase,
    planned: report.planned,
    executed: executed.length,
    notExecuted: report.planned - executed.length,
    aborted: report.aborted,
    totals: report.totals,
    completed: executed.filter(run => run.status === 'completed').length,
    stopped: executed.filter(run => run.status !== 'completed' && !run.error).length,
    errored: executed.filter(run => run.error !== undefined).length,
    accepted: executed.filter(run => run.accepted === true).length,
    rejected: executed.filter(run => run.accepted === false).length,
    infeasible,
    rate: { numerator, denominator: rateable.length, excludedInfeasible: infeasible, excludedErrored: errored },
  }
}
