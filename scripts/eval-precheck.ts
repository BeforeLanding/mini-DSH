import { ablationIds } from './coding-fixtures.js'
import type { FixtureId } from './coding-fixtures.js'
import { ablationPolicy, toolOutputPolicy } from './eval-runner.js'
import type { PromptLayoutMode, RunOutcome, ToolOutputMode } from './eval-runner.js'
import { runFixtureTask, scriptedAdapter, UNBOUNDED_PREVIEW_BYTES } from './eval-fixture.js'
import type { Fixture, FixtureAdapter } from './eval-fixture.js'
import { assertToolProtocol } from '../src/core/context-runtime.js'
import type { ChatRequest, ChatResponse, ToolCall } from '../src/core/contracts.js'

// NX-39-5 的离线因子预检，零付费。R-21 的验收条款要求「不满足时不得开跑对照」，而 NX-08f 的教训是这类
// 检查最容易犯两个方向的错，因此这里把两件事分开量、分开下结论：
//
//   · **结构性前提**（逐 fixture）：该任务集能不能让这条处理出手。单任务会话里没有任何「已结束且非当前」
//     的任务组可移除，裁剪因此必然为零——那是机制决定的，不是「没测出来」。这一条由读数给出，不由推理给出。
//   · **机制**（合成驱动，一次）：装置在被驱动到阈值以上时确实会出手。这是 R-21 要问的那个问题，也是
//     NX-08f 里唯一答对的那一半：离线装置证明了有界/无界能分辨（39.5 倍），真实模型却从未触发。**预检
//     回答的是「能不能」，不是「会不会」**——「会不会」只能由付费证据的触发率回答。
//
// 第三条读数（脚本化最小序列下每项的峰值与出手次数）**不是预测**：脚本化驱动只做「读可改文件 → 跑公开
// 检查 → 改 → 再跑」，它读不了 fixture 里那些需要先定位的大日志，也不会有模型的自发探索。因此它的数字是
// **下界**，用途是看余量，不是用来判「仪器是否成立」。

// 与真实评测同一套装配参数：有界档走生产默认预览上限（16 KiB），无界档抬到 64 MiB（见 eval-fixture）。
const WINDOW = 1_000_000
const OFF_TOOL_OUTPUT: ToolOutputMode = toolOutputPolicy('baseline')!
const ON_TOOL_OUTPUT: ToolOutputMode = toolOutputPolicy('context')!
// 压缩阈值 = compactionBudgetTokens × compactionRatio，而 `compactionBudgetTokens` 缺省取 inputTargetTokens
// （budget.ts 刻意的设计：写死它会让调整输入目标时压缩阈值不再跟着走）。因此这里必须按同一条优先级取，
// 直接读 `compactionBudgetTokens` 会拿到 undefined 并把阈值算成 0——那会让「余量」那一行报出一个看起来
// 已经越过阈值 4529 的假读数。
const onPolicy = ablationPolicy('context', WINDOW)
const PRESSURE_THRESHOLD = Math.round((onPolicy.compactionBudgetTokens ?? onPolicy.inputTargetTokens ?? 0) * (onPolicy.compactionRatio ?? 0.8))

export interface ArmReading {
  projections: number
  peakEstimatedInputTokens: number
  stages: number
  prunedStages: number
  compactions: { applied: number; pressure: number; declined: number }
  previewTruncations: number
  status: string
  accepted: boolean | null
}

export interface FixturePrecheck {
  fixture: FixtureId
  off: ArmReading
  on: ArmReading
}

function read(outcome: RunOutcome): ArmReading {
  const stages = outcome.tasks ?? []
  const compactions = stages.reduce((total, stage) => ({
    applied: total.applied + (stage.compactions?.applied ?? 0),
    pressure: total.pressure + (stage.compactions?.pressure ?? 0),
    declined: total.declined + (stage.compactions?.declined ?? 0),
  }), { applied: 0, pressure: 0, declined: 0 })
  return {
    projections: stages.reduce((total, stage) => total + stage.projections, 0),
    peakEstimatedInputTokens: stages.reduce((peak, stage) => Math.max(peak, stage.maxEstimatedInputTokens ?? 0), 0),
    stages: stages.length,
    prunedStages: stages.filter(stage => stage.firstPrunedProjection !== null).length,
    compactions,
    previewTruncations: outcome.counters.previewTruncations,
    status: outcome.status,
    accepted: outcome.accepted,
  }
}

// 逐 fixture 跑两档：关档（因子 1 off）与开档（因子 1 on）。两档之间只差 `ablationPolicy` 与
// `toolOutputPolicy` 那两个映射的输出——这一条由 eval-runner 的用例按值钉住，这里不重复断言。
// 提示布局不传：因子 2 与因子 1 的两半无关，装载它只会让每次运行多渲染两段提示而量到同一个数。
export async function precheckFixture(id: FixtureId): Promise<FixturePrecheck> {
  const off = await runFixtureTask(id, scriptedAdapter, ablationPolicy('baseline', WINDOW), undefined, OFF_TOOL_OUTPUT)
  const on = await runFixtureTask(id, scriptedAdapter, ablationPolicy('context', WINDOW), undefined, ON_TOOL_OUTPUT)
  return { fixture: id, off: read(off), on: read(on) }
}

export async function precheckFixtures(ids: readonly FixtureId[] = ablationIds): Promise<FixturePrecheck[]> {
  const readings: FixturePrecheck[] = []
  for (const id of ids) readings.push(await precheckFixture(id))
  return readings
}

// ── 机制探针 ────────────────────────────────────────────────────────────────────────────────────
// 合成驱动：每条命令吐一大段输出，直到步数上限。它不是模型替身，也不解任何任务——它唯一的用途是把历史
// **推到阈值以上**，让「处理会不会出手」变成可观测的。压缩请求由它自己回答（那是真实跑里模型唯一能影响
// 「压完还剩什么」的地方，见 test/nx38-covenant.test.ts 的同一条约定）。
const PADDING_CHARS = 64_000
// 步数只需够把历史推过压缩阈值：有界档每条命令的预览是 16 KiB ≈ 4,915 估算 token，越过 52,429 约需
// 11 轮。留到 16 是余量而不是目标——步数越多探针越慢，而它每次都要真跑一遍引擎。
const PADDING_STEPS = 16
const COMPACTION_MARK = '上面的对话正在被摘要'
const PROBE_SUMMARY = '## Primary Request\npadding probe\n## Completed Work\nread padding\n## Pending Work\ncontinue padding\n## Key Evidence\noriginal events remain in the log'
const PADDING_COMMAND = `node -e 'process.stdout.write("x".repeat(${PADDING_CHARS}))'`

function paddingAdapter(): FixtureAdapter {
  let step = 0
  return {
    provider: 'scripted', model: 'fixture', capabilities: { fixture: { contextWindowTokens: WINDOW } },
    chat: async ({ messages = [] }: ChatRequest): Promise<ChatResponse> => {
      assertToolProtocol(messages)
      const users = messages.filter(message => message.role === 'user').map(message => String(message.content ?? ''))
      if (users.some(content => content.includes(COMPACTION_MARK))) return { content: PROBE_SUMMARY }
      if (step >= PADDING_STEPS) return { content: 'padding finished' }
      step += 1
      const call: ToolCall = { id: `pad-${step}`, name: 'bash', arguments: { command: PADDING_COMMAND } }
      return { toolCalls: [call] }
    },
  }
}

export interface ProbeReading {
  bounded: ArmReading
  unbounded: ArmReading
}

// 一次探针，在两档装配下跑同一台合成驱动。**两档都要跑**：只说「有界档截断了」证明不了是有界性带来的
// ——无界档同样截断的话，那是驱动的功劳。
export async function probeMechanism(): Promise<ProbeReading> {
  const bounded = await runFixtureTask('boundary', paddingAdapter, ablationPolicy('context', WINDOW), undefined, ON_TOOL_OUTPUT)
  const unbounded = await runFixtureTask('boundary', paddingAdapter, ablationPolicy('context', WINDOW), undefined, OFF_TOOL_OUTPUT)
  return { bounded: read(bounded), unbounded: read(unbounded) }
}

// 因子 2 的一次读数：同一台脚本化驱动，两档布局。量的是「第 2 轮起与前一轮逐字相同」的轮数，
// 与付费证据上聚合器用的是同一个字段（`context/projection` 里的系统提示摘要），因此预检与正式报告
// 不可能对「稳定」给出两个定义。
export interface LayoutReading { frozen: boolean; rounds: number; stable: number; prompts: number }

export async function probePromptLayout(id: FixtureId = 'boundary'): Promise<LayoutReading[]> {
  const readings: LayoutReading[] = []
  for (const frozen of [false, true]) {
    const layout: PromptLayoutMode = { frozen }
    // 采集每轮装配出的系统提示原文：轮数与稳定性由运行器从投影摘要里算（上面那条口径），这里另外数
    // **不同的文本数**，用来证明摘要比对确实对应「换了一串字符」而不是别的什么。
    const prompts = new Set<string>()
    const adapt = (fixture: Fixture): FixtureAdapter => {
      const inner = scriptedAdapter(fixture)
      return {
        ...inner,
        chat: async (request: ChatRequest): Promise<ChatResponse> => {
          prompts.add(request.system ?? '')
          return inner.chat(request)
        },
      }
    }
    const outcome = await runFixtureTask(id, adapt, ablationPolicy('baseline', WINDOW), undefined, undefined, layout)
    const stages = outcome.tasks ?? []
    readings.push({
      frozen,
      rounds: stages.reduce((total, stage) => total + (stage.promptRounds?.rounds ?? 0), 0),
      stable: stages.reduce((total, stage) => total + (stage.promptRounds?.stable ?? 0), 0),
      prompts: prompts.size,
    })
  }
  return readings
}

// ── 判定 ────────────────────────────────────────────────────────────────────────────────────────
export interface PrecheckVerdict {
  // 结构性事实：每一项都是单任务的项数。等于总项数时，裁剪半边在本任务集上恒为零。
  singleStageFixtures: number
  totalFixtures: number
  // 脚本化最小序列下的**下界**读数（数的是「出手过的项数」）。
  scriptedPressure: number
  scriptedTruncation: number
  // 峰值离压缩阈值的余量：最大的那一次「还差多少」，负数表示已经越过。
  closestToThreshold: { fixture: FixtureId; peak: number; gap: number } | null
  // 机制探针：两半能不能出手。不成立即 R-21 的「不得开跑对照」。
  truncationMechanism: boolean
  pressureMechanism: boolean
  promptLayout: { liveChanges: boolean; frozenPinned: boolean }
  reasons: string[]
}

export function precheckVerdict(readings: readonly FixturePrecheck[], probe: ProbeReading, layouts: readonly LayoutReading[]): PrecheckVerdict {
  const reasons: string[] = []
  const total = readings.length
  const singleStage = readings.filter(item => item.off.stages <= 1 && item.on.stages <= 1).length
  if (singleStage === total) reasons.push(`全部 ${total} 项都是单任务会话：没有任何「已结束且非当前」的任务组可移除，裁剪在这些任务上恒为零（机制决定，已作为范围声明写进预注册）`)
  else if (singleStage > 0) reasons.push(`${singleStage}/${total} 项是单任务，裁剪在它们上恒为零`)

  const peaks = readings.map(item => ({ fixture: item.fixture, peak: item.on.peakEstimatedInputTokens }))
  const closest = peaks.reduce<{ fixture: FixtureId; peak: number; gap: number } | null>((best, item) => {
    const candidate = { ...item, gap: PRESSURE_THRESHOLD - item.peak }
    return best === null || candidate.gap < best.gap ? candidate : best
  }, null)

  const scriptedPressure = readings.filter(item => item.on.compactions.pressure > 0).length
  const scriptedTruncation = readings.filter(item => item.on.previewTruncations > 0).length

  // 机制成立的判据是**对照**：有界档截断了，且无界档同一台驱动没有截断。只看有界档那一半，
  // 一个「无论装什么都会截断」的装置也会看起来成立。
  const truncationMechanism = probe.bounded.previewTruncations > 0 && probe.unbounded.previewTruncations === 0
  const pressureMechanism = probe.bounded.compactions.pressure > 0
  if (!truncationMechanism) reasons.push(`机制探针不成立：有界档 ${probe.bounded.previewTruncations} 次截断、无界档 ${probe.unbounded.previewTruncations} 次——两档必须一有一无，只报有界档那一半证明不了是「有界性」带来的`)
  if (!pressureMechanism) reasons.push(`机制探针不成立：合成驱动把历史推过 ${PRESSURE_THRESHOLD} 之后主动压缩仍未出手（applied ${probe.bounded.compactions.applied}、pressure ${probe.bounded.compactions.pressure}）`)

  const live = layouts.find(item => !item.frozen), frozen = layouts.find(item => item.frozen)
  const liveChanges = live !== undefined && live.prompts > 1
  const frozenPinned = frozen !== undefined && frozen.prompts === 1 && frozen.rounds > 0
  if (!liveChanges) reasons.push('提示布局探针不成立：live 档的系统提示在会话内没有变化，因子 2 会空转')
  if (!frozenPinned) reasons.push('提示布局探针不成立：frozen 档的系统提示在会话内不止一份，冻结没有生效')

  if (scriptedPressure === 0 || scriptedTruncation === 0) {
    reasons.push(`脚本化最小序列下：主动压缩 ${scriptedPressure}/${total} 项出手、预览截断 ${scriptedTruncation}/${total} 项出手。**这不是「仪器未成立」**——该序列读不了需要先定位的大日志、也没有模型的自发探索，它是下界；是否成立由付费证据的触发率判（聚合器）`)
  }
  return {
    singleStageFixtures: singleStage, totalFixtures: total,
    scriptedPressure, scriptedTruncation, closestToThreshold: closest,
    truncationMechanism, pressureMechanism,
    promptLayout: { liveChanges, frozenPinned },
    reasons,
  }
}

export const pressureThreshold = PRESSURE_THRESHOLD
export { UNBOUNDED_PREVIEW_BYTES }
