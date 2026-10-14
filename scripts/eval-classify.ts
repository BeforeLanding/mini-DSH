import { ledgerPhases, phaseCaps } from './eval-runner.js'
import type { LedgerPhase } from './eval-runner.js'

// NX-38-3 预注册的**四类结局**，逐字落进代码。判据表在 PLAN 的「预注册：两批（开跑前写死）」，
// 修改这里必须同步改那一节，否则实现与写死的判据漂移——而这个实验的全部意义就是判据先于结果。
//
// 判定**顺序固定、先命中先归类**：被拒 → 仪器未成立 → 天花板被打破 / 未被打破。顺序不可交换，否则
// 「被拒」会被读成「没记住」：闸门停下时独立验收仍会跑出 accepted，但它测的是「被掐断之后工作区长什么
// 样」，与「载体没被记住」不可区分。NX-08h 的缺口正是把两者混在一起。
export type LedgerVerdict = 'rejected' | 'instrument-not-established' | 'ceiling-broken' | 'ceiling-intact'

export type BatchName = 'A' | 'B'
export const batchArms: Readonly<Record<BatchName, readonly [LedgerPhase, LedgerPhase]>> = Object.freeze({
  // 自变量：inputTargetTokens（裁 / 不裁）。两臂都关主动压缩。
  A: ['ledgerA1', 'ledgerA2'] as const,
  // 自变量：compactionBudgetTokens（主动压缩是否先出手）。两臂输入目标都是 65,536。
  B: ['ledgerB1', 'ledgerB2'] as const,
})

// 证据行的形状：`runs.jsonl` 每行是 `{phase, fixture, repeat, ...RunOutcome}`。只声明判定需要的字段，
// 保证这个模块是纯函数、可以在离线用合成记录驱动。
export interface ArmRun {
  status?: string
  accepted?: boolean | null
  tasks?: readonly {
    taskId: string
    removedTaskIds?: readonly string[]
    maxEstimatedInputTokens?: number
    compactions?: { applied: number; pressure: number; declined: number }
  }[]
}

export type ArmState = 'usable' | 'rejected' | 'instrument-not-established'
export interface ArmVerdict {
  phase: LedgerPhase
  state: ArmState
  reasons: string[]
  // 逐次运行的峰值估算输入（层 A 的处理量）。区间重叠是「裁与不裁分不出来」的判据。
  peaks: number[]
  accepted: (boolean | null)[]
}
export interface BatchVerdict {
  batch: BatchName
  verdict: LedgerVerdict
  reasons: string[]
  arms: ArmVerdict[]
}

const unionRemoved = (run: ArmRun): Set<string> => {
  const removed = new Set<string>()
  for (const stage of run.tasks ?? []) for (const id of stage.removedTaskIds ?? []) removed.add(id)
  return removed
}
const peakOf = (run: ArmRun): number => Math.max(0, ...(run.tasks ?? []).map(stage => stage.maxEstimatedInputTokens ?? 0))

// 第一类：**被拒**。该臂任一次运行的终态 status !== 'completed'（budget.ts 的 StopReason 里除 completed
// 外的全部取值：max_steps / context_overflow / token_budget / ...），或该阶段有计划的运行根本没跑
// （整批上限掐断）。「completed」是唯一算自然结束的状态。
export function classifyArm(phase: LedgerPhase, runs: readonly ArmRun[]): ArmVerdict {
  const reasons: string[] = []
  const expected = phaseCaps[phase].runs
  if (runs.length < expected) reasons.push(`只有 ${runs.length}/${expected} 次运行被执行（整批上限或中断）`)
  runs.forEach((run, index) => {
    if (run.status !== 'completed') reasons.push(`第 ${index + 1} 次运行以 ${String(run.status)} 结束`)
  })
  const peaks = runs.map(peakOf)
  const accepted = runs.map(run => run.accepted ?? null)
  if (reasons.length) return { phase, state: 'rejected', reasons, peaks, accepted }
  if (!accepted.some(value => value !== null)) return { phase, state: 'instrument-not-established', reasons: ['没有一次运行留下可用的结局读数'], peaks, accepted }
  return { phase, state: 'usable', reasons, peaks, accepted }
}

// 层 A（逐批）：处理必须真的发生过。A 批看载体有没有被裁掉、两臂的处理量分不分得开；
// B 批看主动压缩有没有出手（B1 必须出手、B2 必须一次都不出手——兜底压缩不看阈值，它出手意味着那次
// 运行随后必然以 context_overflow 结束，那一类已经在上一步被归入「被拒」）。
function layerA(batch: BatchName, arms: readonly ArmVerdict[], runs: readonly (readonly ArmRun[])[]): string[] {
  const reasons: string[] = []
  const [first, second] = arms
  if (batch === 'A') {
    // 载体是第 1 阶段那条 user/message，住在第 1 阶段的 task 里；它只能被后续阶段裁掉。
    runs[1].forEach((run, index) => {
      const carrier = run.tasks?.[0]?.taskId
      if (carrier === undefined || !unionRemoved(run).has(carrier)) reasons.push(`A2 第 ${index + 1} 次运行没有裁掉第 1 阶段的 task（载体从未离开上下文）`)
    })
    const low = Math.min(...first.peaks), high = Math.max(...first.peaks)
    const low2 = Math.min(...second.peaks), high2 = Math.max(...second.peaks)
    if (low <= high2 && low2 <= high) reasons.push(`两臂的处理量区间重叠（A1 ${low}–${high}，A2 ${low2}–${high2}），裁与不裁分不出来`)
  } else {
    const pressure = (list: readonly ArmRun[]) => list.reduce((total, run) => total + (run.tasks ?? []).reduce((sub, stage) => sub + (stage.compactions?.pressure ?? 0), 0), 0)
    const applied = (list: readonly ArmRun[]) => list.reduce((total, run) => total + (run.tasks ?? []).reduce((sub, stage) => sub + (stage.compactions?.applied ?? 0), 0), 0)
    if (pressure(runs[0]) === 0) reasons.push('B1 一次主动压缩都没有触发（自变量从未被触发）')
    if (applied(runs[1]) !== 0) reasons.push(`B2 出现了 ${applied(runs[1])} 次已应用的压缩（「关主动压缩」没关上）`)
  }
  return reasons
}

// evidence 只要求给出该批的那两臂：缺的那一臂按「一次都没跑」处理（0/3 → 被拒），而不是静默当成空证据。
export function classifyBatch(batch: BatchName, evidence: Readonly<Partial<Record<LedgerPhase, readonly ArmRun[]>>>): BatchVerdict {
  const phases = batchArms[batch]
  const runs = phases.map(phase => evidence[phase] ?? [])
  const arms = phases.map((phase, index) => classifyArm(phase, runs[index]))
  const rejected = arms.filter(arm => arm.state === 'rejected')
  if (rejected.length) return { batch, verdict: 'rejected', reasons: rejected.flatMap(arm => arm.reasons.map(reason => `${arm.phase}：${reason}`)), arms }
  // 被拒之外还有「一臂不成立」的情形：例如 A1 正常而 A2 没有可用读数。层 A 需要两臂同时可用。
  const unusable = arms.filter(arm => arm.state === 'instrument-not-established')
  if (unusable.length) return { batch, verdict: 'instrument-not-established', reasons: unusable.flatMap(arm => arm.reasons.map(reason => `${arm.phase}：${reason}`)), arms }
  const instrument = layerA(batch, arms, runs)
  if (instrument.length) return { batch, verdict: 'instrument-not-established', reasons: instrument, arms }
  const values = new Set(arms.flatMap(arm => arm.accepted).filter((value): value is boolean => value !== null))
  if (values.size >= 2) return { batch, verdict: 'ceiling-broken', reasons: [`两臂的 accepted 取到 ${values.size} 个不同的值`], arms }
  return { batch, verdict: 'ceiling-intact', reasons: [`两臂的 accepted 只有一个值（${[...values][0]}）`], arms }
}

// 判定所覆盖的两批四条臂。导出来是为了让调用方与测试共用同一份清单，不在两处各写一遍。
export const classifyPhases = ledgerPhases
