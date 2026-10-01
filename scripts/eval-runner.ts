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
export interface BatchCaps { runs: number; requests: number; tokens: number }
// batchCaps 是「整批 18 次运行」这条预注册结论的载体，因此它的成员被单独列出来，而不是「PhaseName 的
// 全部」：诊断烟测会随开发增减，让它混进预注册算术会让那个数字不再对应同一件事。
export const batchPhases = ['screening', 'armA', 'armB'] as const
export type BatchPhase = typeof batchPhases[number]
export type PhaseName = BatchPhase | 'sequence' | 'smoke' | 'blind'
export const phaseCaps: Readonly<Record<PhaseName, BatchCaps>> = Object.freeze({
  screening: { runs: 12, requests: 400, tokens: 8_000_000 },
  // 对照 A 的两臂各 3 次运行（NX-08e2-6 按实测重预注册，NX-08e2-4 之后随序列扩到十四阶段再重算一次；
  // 旧算式「12 任务 × 2 臂 × 3 次」随 fixture 变成多阶段序列而作废）。这里的「一次运行」是整条**十四阶段**序列。
  // requests 取理论上界（3 × 14 阶段 × 32 请求 = 1344，进位到 1400）——与筛查同口径。取上界而不是实测是
  // 刻意的：请求数 32 是「两臂获得相同工作量」的约束，上限若比它更紧就会在批次中途掐断某一臂，让被比较的
  // 东西从上下文策略变成预算；6 阶段批次两臂实际只用掉 100 / 125 请求，离上界很远正是它该有的样子。
  // tokens 取「3 × 实测单条 × 2 倍余量」：14 阶段诊断实测单条 6,379,862 token（132 请求，accepted=true），
  // 3 × 2 × 6,379,862 = 38,279,172，进位到 40,000,000。
  // **这条数值先按外推写过一版，被实测推翻，教训留在这里**：当时按 10 阶段的 2,639,688 加上 4 个「同量级」
  // 的受裁剪阶段外推得 3,884,608，实测高了 64%。原因是 token 由**每阶段请求数**驱动，不是阶段数线性外推——
  // 14 阶段平均 9.4 请求/阶段（第 6、9、13 阶段分别 17、15、13 次），而 10 阶段那次只有 6.4。按外推值定的
  // 24,000,000 对 3 次运行只剩 25% 余量，而 6 阶段批次的跑次间波动有 2.4 倍宽，那个上限正好会犯下面
  // 明令禁止的错：在中途掐断某一臂，让被比较的东西从上下文策略变成预算。
  // 参考量级：6 阶段批次上限 15,000,000，两臂实际用掉 3,910,735 / 4,277,915。
  // 单次 run 预算仍是每阶段一份，是每次运行的硬闸门。
  // runs 是**该阶段一共要跑几次**，不只是中止阈值：registry 只有 1 个 fixture，因此它是「每个 fixture
  // 重复 3 次」，由 eval-cli 的 repeatCount/resolveRuns 展开成真正的执行清单。NX-08e 之前的实现只把它
  // 当中止阈值用，一条命令实际只跑 1 次——`test/eval-cli.test.ts` 现在把「上限」和「计划长度」钉在一起。
  armA: { runs: 3, requests: 1_400, tokens: 40_000_000 },
  armB: { runs: 3, requests: 1_400, tokens: 40_000_000 },
  // sequence 是 NX-08e2 的诊断烟测（多阶段 fixture pipeline），不是预注册对照批次的一部分。
  // 数值取逐阶段预算的理论上界：该阶段的计划里只有 1 个 fixture，而 runPhase 只在两次 fixture 之间
  // 检查累计值，整批上限对它本来就不构成中途制动——取更紧的值只会把一次跑完的烟测变成带 aborted 的
  // 退出码 1，拦不住任何花费。烟测真正的闸门是每阶段的 singleRunBudget（32 请求 / 2,000,000 token），
  // 阶段数 × 这组值即这里的 448 / 28,000,000（NX-08e2-4 把序列从 6 阶段扩到 10 阶段，再扩到 14 阶段）。
  // 上限必须跟着阶段数走：留在旧值上，新的理论上界就会越过去，把一次正常的烟测记成 aborted。
  sequence: { runs: 1, requests: 448, tokens: 28_000_000 },
  // smoke 是 NX-08f 的诊断烟测（单任务 fixture audit，无界工具输出），回答「真实模型会不会真的产生
  // 那份报告」。与 sequence 同口径取**单次 run 预算的理论上界**：该阶段的计划里只有 1 个 fixture，而
  // runPhase 只在两次 fixture 之间检查累计值，整批上限对它本来就不构成中途制动——取更紧的值只会把一次
  // 跑完的烟测变成带 aborted 的退出码 1，拦不住任何花费。烟测真正的闸门是 singleRunBudget。
  // 它不进 batchPhases：对照 B 正式的两臂（armC/armD）与它们的上限留到 NX-08f-5 按实测预注册。
  smoke: { runs: 1, requests: 32, tokens: 2_000_000 },
  // blind 是 NX-08h 的诊断烟测（多阶段 fixture blind，工作区里没有公开 check.mjs），回答「没有 oracle
  // 之后模型的产出还过得去吗」——也就是 NX-08g0 判定的天花板是否真的来自那条机制。与 sequence 同口径
  // 取**逐阶段预算的理论上界**（14 阶段 × 32 请求 = 448；14 阶段 × 2,000,000 token = 28,000,000）：
  // 该阶段的计划里只有 1 个 fixture，而 runPhase 只在两次 fixture 之间检查累计值，整批上限对它本来
  // 就不构成中途制动——取更紧的值只会把一次跑完的烟测变成带 aborted 的退出码 1，拦不住任何花费。
  // 上限必须跟着阶段数走，理由同 sequence（留在旧值上会把正常烟测记成 aborted）。
  // **这不是 NX-08h 的正式预注册数字**：NX-08g0 要求「不得沿用本轮的 phaseCaps 数字」，指的是不得把
  // NX-08e 那套对照 A 的上限搬过来。这里是机械推导，`blind` 上的正式对照批次尚未预注册，其上限要等
  // 这次烟测的实测之后另行确定与授权（NX-08e2 的教训：按外推定的 token 上限被实测推翻过 64%）。
  // 它也不进 batchPhases：诊断烟测会随开发增减，混进预注册算术会让 {18, 3_200, 88_000_000} 不再
  // 对应同一件事。
  blind: { runs: 1, requests: 448, tokens: 28_000_000 },
})
export const batchCaps: Readonly<BatchCaps> = Object.freeze(batchPhases.reduce((totals, name) => ({
  runs: totals.runs + phaseCaps[name].runs,
  requests: totals.requests + phaseCaps[name].requests,
  tokens: totals.tokens + phaseCaps[name].tokens,
}), { runs: 0, requests: 0, tokens: 0 }))
// 对照 A 的两臂只差上下文策略：R-21 要求模型、prompt、初始状态、验收器与单次 run 预算完全一致，所以差异
// 被压缩到一个可观察的量——输入目标。armB 用 PLAN 文档默认的 65,536（历史超出就移除最旧的完整任务）；
// armA 把输入目标抬到模型窗口，让「输入 ≤ 目标」这一条恒成立，历史只受窗口容量约束。
// 称它「全历史」要说清边界：它不是无限，输入 + 输出预留 + 容量余量仍须落在窗口内，越过就是
// context_overflow 而不是静默截断。输出预留只由 maxTotalTokens / maxOutputTokens 决定、与输入目标无关，
// 所以两臂的差异确实只在裁剪上。窗口不高于 armB 的目标时直接失败，而不是静默把两臂对调。
export function armPolicy(phase: BatchPhase, contextWindowTokens: number): Readonly<BudgetPolicy> {
  if (phase !== 'armA') return evalPolicy
  if (contextWindowTokens <= (evalPolicy.inputTargetTokens ?? 0)) throw new Error(`arm A needs a window larger than arm B's input target, got ${contextWindowTokens}`)
  return Object.freeze({ ...evalPolicy, inputTargetTokens: contextWindowTokens })
}

// 对照 B 的自变量：工具输出是否有界。两臂都装载同一个 tool-results 插件、只改它的配置——插件无条件
// 注册 read_tool_result，装与不装会让 tools.schemas() 相差一个条目，而工具表既进入模型请求又进入输入
// 估算，那样两臂差的就不只是有界性，R-21 的「同一 prompt 与工具」不再成立。
export interface ToolOutputMode { bounded: boolean }
// 阶段 → 工具输出模式。只有 smoke（NX-08f 的诊断烟测）返回配置，其余阶段返回 undefined = **不装载**
// tool-results 插件，screening / armA / armB / sequence 与全部离线用例的行为因此一字不变。
// smoke 取无界：烟测要回答的正是「模型会不会真的产生大输出」，那是有界臂永远问不出来的问题。
// 对照 B 正式的两臂（armC 有界 / armD 无界）在 NX-08f-5 按实测预注册时再加进来。
export function toolOutputPolicy(phase: PhaseName): ToolOutputMode | undefined {
  return phase === 'smoke' ? { bounded: false } : undefined
}
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
