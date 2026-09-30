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
export interface RunOutcome {
  status: StopReason | 'running'
  counters: Counters
  accepted: boolean | null
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
export async function runPhase<T>(phase: PhaseName, planned: readonly T[], caps: BatchCaps, execute: (task: T) => Promise<RunOutcome>): Promise<PhaseReport<T>> {
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
    executed.push({ ...outcome, task })
    totals.runs += 1
    totals.requests += outcome.counters.modelRequests
    totals.tokens += outcome.counters.totalTokens
    const crossed = overCap(totals, caps, true)
    if (crossed) { aborted = crossed; break }
  }
  return { phase, planned: planned.length, executed, aborted, totals }
}

// 阶段中止不是任务失败：已执行的 run 保留各自的真实状态与验收结论，中止只说明剩余 run 未执行。
export function summarize<T>(report: PhaseReport<T>) {
  return {
    phase: report.phase,
    planned: report.planned,
    executed: report.executed.length,
    notExecuted: report.planned - report.executed.length,
    aborted: report.aborted,
    totals: report.totals,
    completed: report.executed.filter(run => run.status === 'completed').length,
    stopped: report.executed.filter(run => run.status !== 'completed' && !run.error).length,
    errored: report.executed.filter(run => run.error !== undefined).length,
    accepted: report.executed.filter(run => run.accepted === true).length,
    rejected: report.executed.filter(run => run.accepted === false).length,
  }
}
