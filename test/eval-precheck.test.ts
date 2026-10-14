import test from 'node:test'
import assert from 'node:assert/strict'
import { precheckFixture, precheckVerdict, pressureThreshold, probeMechanism, probePromptLayout } from '../scripts/eval-precheck.js'
import type { FixturePrecheck, LayoutReading, ProbeReading } from '../scripts/eval-precheck.js'

// NX-39-5 的离线因子预检。它要回答的是 R-21 那一问——「装置在被驱动到阈值以上时会不会出手」，
// 而**不是**「真实模型会不会触发」：后者只能由付费证据的触发率回答（NX-08f 的教训正是把这两件事混了。
// 那次的离线装置证明了有界/无界能分辨 39.5 倍，真实模型却从未产生大输出）。
//
// 因此这里用两组用例分开钉：一组是判定函数的纯逻辑（哪个失效方式判红），一组是**真跑一遍机制探针**
// ——它盯的是仪器本身会不会随时间失效（阈值改了、预览上限改了、压缩路径改了），那种失效静默且致命。

const arm = (overrides: Partial<FixturePrecheck['on']> = {}) => ({
  projections: 5, peakEstimatedInputTokens: 4_000, stages: 1, prunedStages: 0,
  compactions: { applied: 0, pressure: 0, declined: 0 }, previewTruncations: 0,
  status: 'completed', accepted: true, ...overrides,
})
const reading = (fixture: string, stages = 1): FixturePrecheck => ({
  fixture: fixture as FixturePrecheck['fixture'],
  off: arm({ stages }), on: arm({ stages }),
})
const probe = (bounded: number, unbounded: number, pressure: number): ProbeReading => ({
  bounded: arm({ previewTruncations: bounded, compactions: { applied: pressure, pressure, declined: 0 } }),
  unbounded: arm({ previewTruncations: unbounded }),
})
const layouts = (livePrompts: number, frozenPrompts: number): LayoutReading[] => [
  { frozen: false, rounds: 5, stable: 0, prompts: livePrompts },
  { frozen: true, rounds: 5, stable: 4, prompts: frozenPrompts },
]
const healthy = () => precheckVerdict([reading('boundary')], probe(16, 0, 1), layouts(5, 1))

test('a healthy instrument passes, and the threshold is the production compaction line', () => {
  const verdict = healthy()
  assert.equal(verdict.truncationMechanism, true)
  assert.equal(verdict.pressureMechanism, true)
  assert.deepEqual(verdict.promptLayout, { liveChanges: true, frozenPinned: true })
  // 阈值取 compactionBudgetTokens ?? inputTargetTokens 再乘 ratio——直接读 compactionBudgetTokens 会拿到
  // undefined 并把阈值算成 0，那会让「余量」那一行报出一个假的「已越过」。
  assert.equal(pressureThreshold, Math.round(65_536 * 0.8))
})

test('truncation only counts as a mechanism when the unbounded arm does not truncate too', () => {
  // 两档都截断 ⇒ 那是驱动的功劳，不是「有界性」的。只报有界档那一半，一个无论装什么都会截断的装置
  // 也会看起来成立。
  const verdict = precheckVerdict([reading('boundary')], probe(16, 3, 1), layouts(5, 1))
  assert.equal(verdict.truncationMechanism, false)
  assert.ok(verdict.reasons.some(reason => reason.includes('两档必须一有一无')))
})

test('a silent compaction path and a static live prompt are both reported', () => {
  const verdict = precheckVerdict([reading('boundary')], probe(16, 0, 0), layouts(1, 1))
  assert.equal(verdict.pressureMechanism, false)
  assert.equal(verdict.promptLayout.liveChanges, false)
  assert.equal(verdict.promptLayout.frozenPinned, true)
  assert.ok(verdict.reasons.some(reason => reason.includes('主动压缩仍未出手')))
  assert.ok(verdict.reasons.some(reason => reason.includes('因子 2 会空转')))
  // frozen 档渲染出多份提示同理：冻结没生效。
  assert.equal(precheckVerdict([reading('boundary')], probe(16, 0, 1), layouts(5, 3)).promptLayout.frozenPinned, false)
})

test('the scripted lower bound is reported but never blocks a run', () => {
  // 脚本化最小序列一次也没触发，**不**判「仪器未成立」——它读不了需要先定位的大日志，也没有模型的
  // 自发探索。把它当成判据，NX-08f 那次「离线装置分辨得出来、真实模型从不触发」的结论就会被倒过来误读。
  const verdict = precheckVerdict([reading('boundary'), reading('options')], probe(16, 0, 1), layouts(5, 1))
  assert.equal(verdict.scriptedPressure, 0)
  assert.equal(verdict.scriptedTruncation, 0)
  assert.ok(verdict.reasons.some(reason => reason.includes('这不是「仪器未成立」')))
  assert.equal(verdict.truncationMechanism && verdict.pressureMechanism, true)
})

test('the single-stage finding and the headroom are read, not reasoned about', () => {
  const many = [reading('boundary'), reading('options', 4)]
  const verdict = precheckVerdict(many, probe(16, 0, 1), layouts(5, 1))
  assert.equal(verdict.singleStageFixtures, 1)
  assert.equal(verdict.totalFixtures, 2)
  assert.ok(verdict.reasons.some(reason => reason.includes('1/2 项是单任务')))
  // 离阈值最近的一项报的是「还差多少」：这一行是开跑前唯一能提醒「会话规模离阈值太远」的地方。
  assert.deepEqual(verdict.closestToThreshold, { fixture: 'boundary', peak: 4_000, gap: pressureThreshold - 4_000 })
  const allSingle = precheckVerdict([reading('boundary')], probe(16, 0, 1), layouts(5, 1))
  assert.ok(allSingle.reasons.some(reason => reason.includes('恒为零')))
})

// ── 真跑：机制探针与逐 fixture 读数 ──────────────────────────────────────────────────────────────

test('a scripted fixture run reports one stage and no treatment for either arm', { timeout: 120_000 }, async () => {
  const item = await precheckFixture('boundary')
  assert.equal(item.fixture, 'boundary')
  // 单任务：这正是 ④ 声明的结构性事实的**读数**（裁剪恒为零），不是推理。
  assert.equal(item.on.stages, 1)
  assert.equal(item.on.prunedStages, 0)
  assert.equal(item.off.prunedStages, 0)
  assert.ok(item.on.peakEstimatedInputTokens > 0, '一次真跑的峰值不该是 0，否则投影没落进读数')
  // 脚本化最小序列既够不到压缩阈值，也没有超过预览上限的输出。
  assert.ok(item.on.peakEstimatedInputTokens < pressureThreshold)
  assert.equal(item.on.compactions.pressure, 0)
  assert.equal(item.on.previewTruncations, 0)
})

test('the instrument fires when driven past the thresholds, in both directions', { timeout: 300_000 }, async () => {
  const reading = await probeMechanism()
  // 有界性：有界档截断、无界档同一台驱动不截断。两档装配只差 toolOutputPolicy，其余逐字相同。
  assert.ok(reading.bounded.previewTruncations > 0, '有界档必须截断，否则「工具输出有界」这一半无法成立')
  assert.equal(reading.unbounded.previewTruncations, 0, '无界档不该截断——它截断就说明量到的不是有界性')
  // 主动压缩：把历史推过 compactionBudgetTokens × ratio 之后它必须出手。这一条是 R-21 那个问题的答案。
  assert.ok(reading.bounded.compactions.pressure > 0, '推过阈值后主动压缩仍未出手：装置坏了，不得开跑对照')
  assert.ok(reading.bounded.peakEstimatedInputTokens > pressureThreshold, '探针必须真的越过阈值，否则上面那条断言什么都没证明')
})

test('the prompt layout probe shows the live arm changing every round and the frozen arm pinned', { timeout: 120_000 }, async () => {
  const [live, frozen] = await probePromptLayout()
  assert.equal(live?.frozen, false)
  assert.equal(frozen?.frozen, true)
  // 因子 2 的空转检测：live 档必须每轮都在变（否则「关掉提示优化掉 0 分」是假零）。
  assert.ok((live?.prompts ?? 0) > 1, 'live 档的系统提示在会话内没有变化：因子 2 空转')
  assert.equal(live?.stable, 0)
  assert.equal(frozen?.prompts, 1, 'frozen 档必须逐字定住')
  assert.equal(frozen?.rounds, live?.rounds, '两档只差 layout，请求数必须相同')
  assert.equal(frozen?.stable, (frozen?.rounds ?? 0) - 1)
})
