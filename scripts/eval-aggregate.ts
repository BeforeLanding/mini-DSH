import { categoryLabels, categoryOrder, fixtureCategory, historicalCategories } from './coding-fixtures.js'
import type { FixtureCategory, FixtureId } from './coding-fixtures.js'
import type { AblationPhase, RunTaskDetail } from './eval-runner.js'

// NX-39-5 的跨批次聚合器。它是**付费之前必须先建好的那件东西**：四格的证据一旦跑出来，口径若还不存在，
// 「报哪些量、按什么分母」就只能在看见结果之后才决定——那正是「按结果挑指标」。因此这里把口径写死成纯
// 函数，让它在开跑之前就能被用例喂合成记录跑一遍。
//
// 它读的是四格各自的 `runs.jsonl`（每行 `{phase, fixture, repeat, ...RunOutcome}`，见 eval-screening.ts
// 的落盘处）。**判定与读数分开**：本文件只算量，`classifyAblation` 才按预注册的规则下结论；调用者是
// `eval-ablation-report.ts`。

// 证据行的形状。只声明聚合需要的字段，且全部可选——一行坏记录应当被读成「缺这一项」，而不是让整批报错，
// 否则一次跑飞的事故会把另外三格的证据一起弄丢。
export interface CellRun {
  phase?: string
  fixture?: string
  repeat?: number
  status?: string
  accepted?: boolean | null
  infeasible?: boolean
  error?: string
  counters?: Partial<{
    modelRequests: number; toolCalls: number; toolErrors: number; previewTruncations: number
    inputTokens: number; outputTokens: number; totalTokens: number; cacheReadTokens: number
  }>
  tasks?: readonly RunTaskDetail[]
}

export interface CategoryRate {
  category: FixtureCategory
  label: string
  // 分子是 accepted 的 run 数，分母是可计分的 run 数（排除不可行与基础设施失败——两者单列，口径同
  // eval-runner 的 summarize）。`runs` 是该类实际执行的 run 数，用来暴露「分母小是因为没跑完」。
  accepted: number
  denominator: number
  runs: number
}

export interface TriggerRates {
  // 每一格的分母都是**该格实际执行的 run 数**。写 0/0 时 rate 记 null，不记 0——「没跑」与「跑了但没触发」
  // 是两件事，压成同一个数正是这条预注册要防的失效方式。
  pressure: { triggered: number; runs: number; rate: number | null }
  truncation: { triggered: number; runs: number; rate: number | null }
  // 因子 2：轮数 ≥ 2 且「第 2 轮起与前一轮逐字相同」的 run 占比。`multiRound` 是分母里真正多轮的 run，
  // 没有它的单轮 run 不构成证据（一轮谈不上「与前一轮相同」）。
  stablePrompt: { triggered: number; multiRound: number; runs: number; rate: number | null }
  // context_overflow 单列：它是「当前任务单独顶穿输入目标」，既不是被拒也不是没触发的处理。
  contextOverflowStages: number
}

export interface CeilingReading {
  // 分子 = 终态 token_budget 的 run 数 ＋ 因整批 tokens 上限未执行的计划 run；分母 = 该格计划运行数。
  tokenBudget: number
  notExecuted: number
  numerator: number
  denominator: number
  rate: number | null
}

export interface MetricFamily {
  modelRounds: number
  toolCalls: number
  toolErrors: number
  previewTruncations: number
  tokens: { input: number; output: number; total: number; cache: number }
  // 逐请求延迟（毫秒）。报 p50/p95 与最大值，**不报合计**——合计会被单次超时拽偏。
  latency: { requests: number; p50: number | null; p95: number | null; max: number | null }
}

export interface CellSummary {
  phase: AblationPhase
  planned: number
  executed: number
  notExecuted: number
  completed: number
  accepted: number
  rejected: number
  infeasible: number
  errored: number
  // 可计分的 run 数（分子分母的口径来源，同 eval-runner 的 summarize）。
  rateable: number
  ceiling: CeilingReading
  rates: CategoryRate[]
  triggers: TriggerRates
  metrics: MetricFamily
}

// 最近秩百分位（nearest-rank）：小样本下平均插值会给出「没有一次请求真的这么慢」的数。向上取整到
// 数组里真实存在的那一个，读数就能被逐条核对。
export function percentile(values: readonly number[], fraction: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((left, right) => left - right)
  const rank = Math.max(1, Math.ceil(fraction * sorted.length))
  return sorted[Math.min(rank, sorted.length) - 1] ?? null
}

const ratio = (part: number, whole: number): number | null => whole > 0 ? part / whole : null
const sum = (values: readonly (number | undefined)[]): number => values.reduce<number>((total, value) => total + (value ?? 0), 0)

// 一行是否可计分：不可行（fixture/Harness 缺陷）与基础设施失败都不进成功率分母，但各自单列。
const rateable = (run: CellRun): boolean => !run.infeasible && run.error === undefined
const executed = (run: CellRun): boolean => run.status !== undefined

function categoryRates(runs: readonly CellRun[]): CategoryRate[] {
  return categoryOrder.map(category => {
    const inCategory = runs.filter(run => run.fixture !== undefined && fixtureCategory(run.fixture as FixtureId) === category)
    const countable = inCategory.filter(rateable)
    return {
      category, label: categoryLabels[category],
      accepted: countable.filter(run => run.accepted === true).length,
      denominator: countable.length,
      runs: inCategory.length,
    }
  })
}

function metricsOf(runs: readonly CellRun[]): MetricFamily {
  const durations = runs.flatMap(run => (run.tasks ?? []).flatMap(stage => stage.requestDurationsMs ?? []))
  return {
    modelRounds: sum(runs.map(run => run.counters?.modelRequests)),
    toolCalls: sum(runs.map(run => run.counters?.toolCalls)),
    toolErrors: sum(runs.map(run => run.counters?.toolErrors)),
    previewTruncations: sum(runs.map(run => run.counters?.previewTruncations)),
    tokens: {
      input: sum(runs.map(run => run.counters?.inputTokens)),
      output: sum(runs.map(run => run.counters?.outputTokens)),
      total: sum(runs.map(run => run.counters?.totalTokens)),
      cache: sum(runs.map(run => run.counters?.cacheReadTokens)),
    },
    latency: {
      requests: durations.length,
      p50: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
      max: durations.length ? Math.max(...durations) : null,
    },
  }
}

export function summarizeCell(phase: AblationPhase, planned: number, runs: readonly CellRun[]): CellSummary {
  const done = runs.filter(executed)
  const notExecuted = Math.max(0, planned - done.length)
  const tokenBudget = done.filter(run => run.status === 'token_budget').length
  const pressureTriggered = done.filter(run => (run.tasks ?? []).some(stage => (stage.compactions?.pressure ?? 0) > 0)).length
  const truncationTriggered = done.filter(run => (run.counters?.previewTruncations ?? 0) > 0).length
  const multiRound = done.filter(run => (run.tasks ?? []).reduce((total, stage) => total + (stage.promptRounds?.rounds ?? 0), 0) > 1)
  // 「第 2 轮起与前一轮逐字相同」按 run 判定：把各阶段的轮数相加，再把各阶段里稳定的轮数相加——跨阶段的
  // 边界不计入比较，因为两个 stage 之间隔着一次新的 `agent.send`，那不是「上一轮」。少算一个比较点是
  // 刻意偏保守的方向：把跨阶段也算稳定只会让仪器看起来更好。
  const stablePromptTriggered = multiRound.filter(run => {
    const rounds = (run.tasks ?? []).reduce((total, stage) => total + (stage.promptRounds?.rounds ?? 0), 0)
    const stable = (run.tasks ?? []).reduce((total, stage) => total + (stage.promptRounds?.stable ?? 0), 0)
    return stable === rounds - 1
  }).length
  return {
    phase, planned,
    executed: done.length,
    notExecuted,
    completed: done.filter(run => run.status === 'completed').length,
    accepted: done.filter(run => run.accepted === true).length,
    rejected: done.filter(run => run.accepted === false).length,
    infeasible: done.filter(run => run.infeasible).length,
    errored: done.filter(run => !run.infeasible && run.error !== undefined).length,
    rateable: done.filter(rateable).length,
    ceiling: {
      tokenBudget, notExecuted,
      numerator: tokenBudget + notExecuted,
      denominator: planned,
      rate: ratio(tokenBudget + notExecuted, planned),
    },
    rates: categoryRates(done),
    triggers: {
      pressure: { triggered: pressureTriggered, runs: done.length, rate: ratio(pressureTriggered, done.length) },
      truncation: { triggered: truncationTriggered, runs: done.length, rate: ratio(truncationTriggered, done.length) },
      stablePrompt: { triggered: stablePromptTriggered, multiRound: multiRound.length, runs: done.length, rate: ratio(stablePromptTriggered, multiRound.length) },
      contextOverflowStages: done.reduce((total, run) => total + (run.tasks ?? []).filter(stage => stage.status === 'context_overflow').length, 0),
    },
    metrics: metricsOf(done),
  }
}

// 前三类的历史下界（预注册写死）：每格前三类成功率 ≥ 11/12，且格间差异不超过 1 次运行。这里的「一次运行」
// 是**每格 3 遍 × 12 项 = 36 次运行**里的分子，因此下界换成计数是 33/36；格间差异 ≤ 1 次运行即
// 「各格前三类 accepted 数的极差 ≤ 1」。把它算成函数而不是散在报告里，是为了让报告没有第二处定义。
export const historicalFloor = { numerator: 33, denominator: 36, spread: 1 } as const

export interface PredictionReading {
  perCell: { phase: AblationPhase; accepted: number; denominator: number; met: boolean }[]
  spread: number | null
  // 三态：`met` 全部格都过下界且极差在界内；`below-floor` 有格低于下界（**这是新装配改变了下限**，
  // 不得读成因子的效果）；`incomplete` 有格没跑满，读不出。
  verdict: 'met' | 'below-floor' | 'incomplete'
}

export function readHistoricalPrediction(cells: readonly CellSummary[]): PredictionReading {
  const perCell = cells.map(cell => {
    const accepted = cell.rates.filter(rate => historicalCategories.includes(rate.category)).reduce((total, rate) => total + rate.accepted, 0)
    const denominator = cell.rates.filter(rate => historicalCategories.includes(rate.category)).reduce((total, rate) => total + rate.denominator, 0)
    return { phase: cell.phase, accepted, denominator, met: accepted >= historicalFloor.numerator && denominator === historicalFloor.denominator }
  })
  const complete = perCell.every(cell => cell.denominator === historicalFloor.denominator)
  const spread = complete ? Math.max(...perCell.map(cell => cell.accepted)) - Math.min(...perCell.map(cell => cell.accepted)) : null
  const verdict = !complete ? 'incomplete'
    : perCell.every(cell => cell.met) && spread !== null && spread <= historicalFloor.spread ? 'met' : 'below-floor'
  return { perCell, spread, verdict }
}

// 预注册的四类结局，按**固定顺序**判定。前两类是「仪器」，后两类是「结局」——顺序不可换：仪器没立起来时
// 谈结局就是谈噪音。
export type AblationVerdict = 'rejected' | 'instrument-not-established' | 'ablation-measured' | 'ceiling-intact'
export interface AblationReading {
  verdict: AblationVerdict
  cells: CellSummary[]
  prediction: PredictionReading
  reasons: string[]
}

// 层 A（处理必须真的发生）成立与否按**因子 1 的两个可判定半边**判：主动压缩与工具输出有界。裁剪半边在本
// 任务集上恒为零，那是开跑前就声明过的结构性事实（20 项全是单任务），不是「没测出来」，因此它不参与这条
// 判定，但必须在报告里单列——把「结构性零」和「触发率零」混成一句话，正是这类实验最容易犯的错。
// 触发率只在**开着那一半的格**（context / full）上量：baseline / prompt 关着因子 1，它们为 0 是设计。
export const factorOnCells: readonly AblationPhase[] = ['context', 'full']

export function classifyAblation(cells: readonly CellSummary[]): AblationReading {
  const reasons: string[] = []
  const byPhase = new Map(cells.map(cell => [cell.phase, cell]))
  const totalExecuted = cells.reduce((total, cell) => total + cell.executed, 0)
  if (totalExecuted === 0) {
    return { verdict: 'rejected', cells: [...cells], prediction: readHistoricalPrediction(cells), reasons: ['四格合计执行 0 次运行：没有可读的证据，不进入任何判定'] }
  }
  const on = factorOnCells.map(phase => byPhase.get(phase)).filter((cell): cell is CellSummary => cell !== undefined)
  const dead = (['pressure', 'truncation'] as const).filter(half => {
    const measured = on.filter(cell => cell.triggers[half].runs > 0)
    return measured.length > 0 && measured.every(cell => cell.triggers[half].triggered === 0)
  })
  const prediction = readHistoricalPrediction(cells)
  for (const half of dead) reasons.push(`因子 1 的「${half === 'pressure' ? '主动压缩' : '工具输出有界'}」这一半在 ${factorOnCells.join('／')} 上一次都没触发（触发率 0）：仪器未成立`)
  if (dead.length) return { verdict: 'instrument-not-established', cells: [...cells], prediction, reasons }
  if (cells.some(cell => cell.executed < cell.planned)) reasons.push(`有格未跑满（${cells.map(cell => `${cell.phase} ${cell.executed}/${cell.planned}`).join('，')}）：结局读数不完整`)
  reasons.push(prediction.verdict === 'below-floor'
    ? '前三类低于预注册下界：这是新装配改变了下限，不得读成因子的效果'
    : prediction.verdict === 'met' ? '前三类落在预注册下界之内（预期饱和）' : '前三类读数不完整，预判未判定')
  // 层 B 的结局口径：四格的成功率是否出现分叉。**不写任何比例或提升**——预注册只要求判「分叉了没有」，
  // 幅度要等报告按分类别的分子分母写。
  const complete = cells.every(cell => cell.executed === cell.planned)
  if (!complete) return { verdict: 'rejected', cells: [...cells], prediction, reasons }
  const rates = cells.map(cell => ratio(cell.accepted, cell.rateable))
  const spread = Math.max(...rates.map(rate => rate ?? 0)) - Math.min(...rates.map(rate => rate ?? 0))
  return { verdict: spread > 0 ? 'ablation-measured' : 'ceiling-intact', cells: [...cells], prediction, reasons }
}

// 报告命令的退出码。**禁止静默跳过**：一次付费 run 都没跑成、或任何一格没跑满，都必须退 1——否则一个
// 「什么都没跑」的批次会以「天花板未破」的形状出现在退出码 0 里，与「跑完了，四格都一样」无从区分。
export function reportExitCode(cells: readonly CellSummary[]): 0 | 1 {
  if (cells.reduce((total, cell) => total + cell.executed, 0) === 0) return 1
  return cells.some(cell => cell.executed < cell.planned) ? 1 : 0
}
