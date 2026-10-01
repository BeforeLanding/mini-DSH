import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { armPolicy, runPhase, summarize, phaseCaps, batchCaps, batchPhases, singleRunBudget, evalPolicy, capKeys } from '../scripts/eval-runner.js'
import type { RunOutcome } from '../scripts/eval-runner.js'
import { runFixtureTask, scriptedAdapter, summarizeStage, type FixtureAdapter, type ToolOutputMode } from '../scripts/eval-fixture.js'
import { createFixture, screeningIds, sequenceIds } from '../scripts/coding-fixtures.js'
import { CLI_BUDGET } from '../src/core/budget.js'
import type { Counters } from '../src/core/budget.js'
import { assertToolProtocol } from '../src/core/context-runtime.js'
import type { ChatRequest, ChatResponse, EventData, SessionEvent } from '../src/core/contracts.js'

// summarizeStage 是对事件数组的纯函数，因此合成日志就能钉住裁剪触发点、未发出投影与 usage 来源这些
// 边界；不该等到真实模型烟测才发现读数不对。
const stageEvent = <K extends keyof EventData>(seq: number, type: K, data: EventData[K], runId = 'run-1'): SessionEvent =>
  ({ version: 1, sessionId: 'session-1', id: `event-${seq}`, taskId: 'task-1', runId, seq, type, data, at: '2026-10-01T00:00:00.000Z' }) as SessionEvent
const projection = (seq: number, estimatedInputTokens: number, removedTaskIds: string[], scope: { requestId?: string; runId?: string } = {}) =>
  stageEvent(seq, 'context/projection', { ...(scope.requestId === undefined ? {} : { requestId: scope.requestId }), estimatedInputTokens, reservedOutputTokens: 4096, safetyMarginTokens: 2048, removedTaskIds }, scope.runId)
const modelStart = (seq: number, requestId: string) => stageEvent(seq, 'model/start', { taskId: 'task-1', runId: 'run-1', requestId, estimatedInputTokens: 100 })
const modelUsage = (seq: number, requestId: string, source: 'provider' | 'estimated') =>
  stageEvent(seq, 'model/usage', { taskId: 'task-1', runId: 'run-1', requestId, usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, source, uncertain: source === 'estimated' } })

const counters = (modelRequests: number, totalTokens: number): Counters =>
  ({ modelRequests, toolCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens, activeDurationMs: 0, approvalDurationMs: 0 })
// 逐字段独立求和，而不是复用 eval-fixture 的 sumCounters：用例要给出「应该是多少」，复用实现里的
// 求和等于用结论证明结论。
const sumStages = (all: readonly Counters[]): Counters => ({
  modelRequests: all.reduce((total, stage) => total + stage.modelRequests, 0),
  toolCalls: all.reduce((total, stage) => total + stage.toolCalls, 0),
  inputTokens: all.reduce((total, stage) => total + stage.inputTokens, 0),
  outputTokens: all.reduce((total, stage) => total + stage.outputTokens, 0),
  totalTokens: all.reduce((total, stage) => total + stage.totalTokens, 0),
  activeDurationMs: all.reduce((total, stage) => total + stage.activeDurationMs, 0),
  approvalDurationMs: all.reduce((total, stage) => total + stage.approvalDurationMs, 0),
})
const done = (modelRequests = 5, totalTokens = 1000): RunOutcome => ({ status: 'completed', counters: counters(modelRequests, totalTokens), accepted: true })
const tasks = (count: number) => Array.from({ length: count }, (_, index) => ({ id: index }))
// 模拟适配器一次性发出「2 × 可编辑文件数 + 2」条命令（每个文件一次 read、一次 edit，外加两次 check），
// 因此命令数随 fixture 的可编辑文件数增长——NX-08e2-4 把 pipeline 扩到 14 阶段后是 15 个文件、正好 32 条，
// 撞上预注册的每 run 32 请求，第一批阶段会被 max_steps 掐断。但这些用例验证的是驱动接线，不该同时受
// 那条约束：32 是对照 A 两臂「拿到相同工作量」的口径，与「阶段能不能跑完」无关，这里放开它。
const driverBudget = { ...evalPolicy, maxModelRequests: 128 }

test('pre-registered caps match PLAN and the phase caps sum to the whole-batch caps', async () => {
  assert.deepEqual(singleRunBudget, { maxModelRequests: 32, maxToolCalls: 64, maxActiveDurationMs: 300_000, maxTotalTokens: 2_000_000 })
  assert.deepEqual(phaseCaps, {
    screening: { runs: 12, requests: 400, tokens: 8_000_000 },
    // 对照 A 的两臂各 3 次运行（NX-08e2-6 按实测重预注册，NX-08e2-4 随序列扩到十四阶段再重算一次）。
    // 这里的一次运行是整条**十四阶段**序列：请求取理论上界（3 × 14 × 32 = 1344→1400），token 取
    // 「3 × 单条 × 2 倍余量」，单条 = 14 阶段诊断实测 6,379,862（按外推写过一版 3,884,608，
    // 被实测推翻，差了 64%——token 由每阶段请求数驱动，不是阶段数线性外推）。
    armA: { runs: 3, requests: 1_400, tokens: 40_000_000 },
    armB: { runs: 3, requests: 1_400, tokens: 40_000_000 },
    // 诊断烟测：单条序列，取逐阶段预算的理论上界（阶段数 × 32 请求 / 阶段数 × 2,000,000 token）。
    // NX-08e2-4 把序列从 6 阶段扩到 10 阶段、再扩到 14 阶段，上限跟着走。
    sequence: { runs: 1, requests: 448, tokens: 28_000_000 },
  })
  // 整批只归约预注册的三个对照阶段。把诊断阶段算进去会改变这个数字的含义，因此按值钉死而不是只断言
  // 求和：以前改 armA 只会静默改变和值，现在会直接撞上预注册数字。
  assert.deepEqual(batchCaps, { runs: 18, requests: 3_200, tokens: 88_000_000 })
  for (const cap of capKeys) assert.equal(batchCaps[cap], batchPhases.reduce((total, name) => total + phaseCaps[name][cap], 0), cap)
  // 单次预算不能替代整批上限：每个 run 都用满单次 token 预算时总量远超整批上限，正是 PLAN 要求独立整批
  // 上限的理由。对照臂的一次运行是整条序列，因此每 run 的上界是「阶段数 × 单次预算」；阶段数从 fixture
  // 本身取，改动阶段数时这条断言会跟着动而不是留下一个对不上的常数。
  const pipeline = await createFixture('pipeline')
  const stages = pipeline.tasks.length
  await pipeline.close()
  assert.ok(phaseCaps.screening.runs * (singleRunBudget.maxTotalTokens ?? 0) > phaseCaps.screening.tokens)
  assert.ok(phaseCaps.armA.runs * stages * (singleRunBudget.maxTotalTokens ?? 0) > phaseCaps.armA.tokens)
  // 诊断阶段的上限是「阶段数 × 单次预算」的理论上界，因此必须与阶段数逐字相等而不是只够用就行：
  // 阶段数一变（NX-08e2-4 从 6 到 10）上限不跟，一次正常的烟测就会越过去、被记成 aborted 并以退出码 1
  // 结束——那是把上限的陈旧读成模型或仪器的毛病。
  assert.equal(phaseCaps.sequence.requests, stages * (singleRunBudget.maxModelRequests ?? 0))
  assert.equal(phaseCaps.sequence.tokens, stages * (singleRunBudget.maxTotalTokens ?? 0))
})

// 预注册只固定四项；上下文目标与窗口必须由文档默认值补上，否则投影不裁剪、context_overflow 不再触发，
// 两臂的上下文差异被一起抹掉。这条断言防止以后把 evalPolicy 退回成 singleRunBudget。
test('the evaluation policy keeps the pre-registered overrides on top of the documented defaults', () => {
  assert.deepEqual(evalPolicy, { ...CLI_BUDGET, ...singleRunBudget })
  assert.equal(evalPolicy.maxModelRequests, 32)
  assert.equal(evalPolicy.maxToolCalls, 64)
  assert.equal(evalPolicy.maxActiveDurationMs, 300_000)
  assert.equal(evalPolicy.maxTotalTokens, 2_000_000)
  assert.equal(evalPolicy.inputTargetTokens, 65_536)
  assert.equal(evalPolicy.maxOutputTokens, 16_384)
  assert.equal(singleRunBudget.inputTargetTokens, undefined)
})

// 对照 A 的两臂除输入目标外必须逐字段相等，否则被比较的就不是上下文裁剪。输出预留只由 maxTotalTokens /
// maxOutputTokens 决定、与输入目标无关，这一点由「其余字段全等」间接钉住。
test('the two comparison arms differ only in the input target', () => {
  const armA = armPolicy('armA', 1_000_000), armB = armPolicy('armB', 1_000_000)
  assert.equal(armA.inputTargetTokens, 1_000_000)
  assert.equal(armB, evalPolicy)
  assert.equal(armB.inputTargetTokens, evalPolicy.inputTargetTokens)
  const withoutTarget = (policy: Readonly<typeof evalPolicy>) => Object.fromEntries(Object.entries(policy).filter(([key]) => key !== 'inputTargetTokens'))
  assert.deepEqual(withoutTarget(armA as typeof evalPolicy), withoutTarget(evalPolicy))
  // 窗口不高于 armB 的目标时直接失败，而不是静默把两臂对调成「armA 裁得更多」。
  assert.throws(() => armPolicy('armA', 65_536), /window larger than arm B/)
})

test('a phase whose run cap equals the planned count completes without a false abort', async () => {
  const report = await runPhase('screening', tasks(12), phaseCaps.screening, async () => done())
  assert.equal(report.executed.length, 12)
  assert.equal(report.aborted, null)
  assert.deepEqual(report.totals, { runs: 12, requests: 60, tokens: 12_000 })
})

test('lowering a cap aborts the phase and leaves executed runs with their own results rather than as failures', async () => {
  const report = await runPhase('armA', tasks(12), { runs: 3, requests: 400, tokens: 8_000_000 }, async () => done())
  assert.equal(report.executed.length, 3)
  assert.deepEqual(report.aborted, { cap: 'runs', limit: 3, observed: 3 })
  assert.ok(report.executed.every(run => run.status === 'completed' && run.accepted === true && run.error === undefined))
  const summary = summarize(report)
  assert.equal(summary.completed, 3)
  assert.equal(summary.notExecuted, 9)
  assert.equal(summary.errored, 0)
})

test('a request cap stops the phase before starting a run it cannot afford', async () => {
  const report = await runPhase('screening', tasks(12), { runs: 12, requests: 10, tokens: 8_000_000 }, async () => done(5, 10))
  assert.equal(report.executed.length, 2)
  assert.deepEqual(report.aborted, { cap: 'requests', limit: 10, observed: 10 })
  assert.equal(report.totals.requests, 10)
})

test('a batch cap never interrupts a run already started, so overshoot is bounded by one run', async () => {
  let started = 0
  const report = await runPhase('armA', tasks(6), { runs: 6, requests: 400, tokens: 100 }, async () => { started += 1; return done(5, 5000) })
  assert.equal(started, 1)
  assert.deepEqual(report.aborted, { cap: 'tokens', limit: 100, observed: 5000 })
  assert.equal(report.executed.length, 1)
  assert.equal(report.executed[0].status, 'completed')
  assert.equal(report.executed[0].counters.totalTokens, 5000)
})

// 全部 12 个任务的离线跑由 `pnpm eval:offline` 承担；此处只取两个 fixture 覆盖运行器与 Harness 的真实接线，
// 避免把 12 次真实子进程验收再加进 Windows CI。
test('the runner drives real fixtures through the harness with a scripted model', { timeout: 60_000 }, async () => {
  const ids = ['boundary', 'merge'] as const
  const report = await runPhase('screening', ids.map(id => ({ id })), phaseCaps.screening, task => runFixtureTask(task.id, scriptedAdapter))
  assert.equal(report.executed.length, 2)
  assert.equal(report.aborted, null)
  assert.ok(report.executed.every(run => run.status === 'completed' && run.accepted === true && run.error === undefined))
  assert.ok(report.executed.every(run => run.counters.modelRequests > 0 && run.counters.totalTokens > 0))
  assert.ok(report.totals.requests < phaseCaps.screening.requests)
})

// 目标值必须在真实 Harness 里生效：把输入目标压到 1 token 后，投影应判定装不下并以 context_overflow
// 停止；若预算策略再次丢掉 inputTargetTokens，这里会退化成 completed。
test('the configured input target reaches the projection inside the harness', { timeout: 60_000 }, async () => {
  const outcome = await runFixtureTask('boundary', scriptedAdapter, { ...evalPolicy, inputTargetTokens: 1 })
  assert.equal(outcome.status, 'context_overflow')
  assert.equal(outcome.accepted, false)
  assert.equal(outcome.counters.modelRequests, 0)
})

// 失败案例要有原始证据：验收结论连同退出码、验收输出与受保护文件变更一起回传，报告不能只有 passed。
test('the fixture driver reports the raw acceptance evidence of each run', { timeout: 60_000 }, async () => {
  const outcome = await runFixtureTask('boundary', scriptedAdapter)
  assert.equal(outcome.accepted, true)
  assert.equal(outcome.acceptance?.exitCode, 0)
  assert.equal(outcome.acceptance?.output.trim(), 'acceptance passed: boundary')
  assert.deepEqual(outcome.acceptance?.protectedFilesChanged, [])
})

// 适配器未声明窗口容量时必须明确失败，而不是以非空断言把缺失的 run 状态伪装成一次运行结论。
test('a policy with a context target fails clearly when the adapter declares no window', { timeout: 60_000 }, async () => {
  const outcome = await runFixtureTask('boundary', fixture => {
    const { chat } = scriptedAdapter(fixture)
    return { provider: 'nocapability', model: 'fixture', chat }
  }, evalPolicy)
  assert.equal(outcome.status, 'error')
  assert.match(outcome.error ?? '', /context capacity must be explicitly configured/)
  assert.deepEqual(outcome.counters, counters(0, 0))
})

// 多阶段路径的端到端覆盖。e0-2 当时只能把缺口写在文档里：没有声明 TASKS/ 布局的真实 fixture 走完
// runFixtureTask，所以 tasks 明细、阶段 counters 求和与「基础设施失败中止后续阶段」都只有单元级与
// Harness 级证据。这条用例把前两条钉在真实驱动上。
test('the driver runs every stage of a sequence fixture and sums their counters', { timeout: 60_000 }, async () => {
  const outcome = await runFixtureTask('pipeline', scriptedAdapter, driverBudget)
  const stages = outcome.tasks ?? []
  // 阶段数从 fixture 自己取，不写死：NX-08e2-4 按实测把序列从 6 段扩到 10 段，字面量会让每次调阶段数
  // 都要回来改这条本来与阶段数无关的用例。它真正要钉的是「每个阶段各跑一次且各拿一个新 taskId」。
  const fixture = await createFixture('pipeline')
  const declared = fixture.tasks.length
  await fixture.close()
  assert.ok(declared > 1)
  assert.equal(stages.length, declared)
  // 每个阶段一次 send，各自拿到新的 taskId；先前结束的阶段因此才是可裁剪的旧任务。
  assert.equal(new Set(stages.map(stage => stage.taskId)).size, declared)
  assert.ok(stages.every(stage => stage.status === 'completed'))
  assert.equal(outcome.status, stages.at(-1)?.status)
  assert.equal(outcome.accepted, true)
  assert.equal(outcome.acceptance?.output.trim(), 'acceptance passed: pipeline')
  assert.equal(outcome.error, undefined)
  assert.deepEqual(outcome.counters, sumStages(stages.map(stage => stage.counters)))
  assert.ok(outcome.counters.modelRequests > stages.length, 'a sequence run costs more than one request per stage')
  // 逐阶段投影观测：模拟适配器在第一个阶段就应用了全部参考改动，全序列估算输入峰值只有 29,307（14 阶段，
  // 6 阶段时是 13,614），远低于输入目标 65,536，因此「未裁剪」在这里是确定性事实而不只是没被观察到——
  // 这让零计数也有断言。注意这个读数随 fixture 的可编辑文件数增长，扩阶段时要跟着更新。
  assert.ok(stages.every(stage => stage.projections > 0))
  assert.ok(stages.every(stage => (stage.maxEstimatedInputTokens ?? 0) >= (stage.estimatedInputTokens ?? 0)))
  assert.ok(stages.every(stage => stage.firstPrunedProjection === null && stage.removedTaskIds.length === 0 && stage.unsentProjections === 0))
  // usage 来源分类要能反映真实出处：模拟适配器不返回 usage，全部由估算补上。
  assert.ok(stages.every(stage => stage.usageSources.estimated === stage.counters.modelRequests && stage.usageSources.provider === 0))
})

// 对照 B 的自变量是「工具输出是否有界」。两臂必须装载**同一个** tool-results 插件、只改它的
// maxPreviewBytes：该插件无条件注册 read_tool_result，装与不装会让 tools.schemas() 相差一个条目，而
// 工具表既进入模型请求又进入输入估算，那样两臂差的就不只是有界性。这条用例用同一个 fixture、同一段
// 大输出、同一预算，只切这一个参数，并直接读回会话事件来钉住结果形态。
test('the bounded tool-output switch truncates a large result while the unbounded one keeps every byte', { timeout: 60_000 }, async () => {
  const command = `node -e 'process.stdout.write("VIOLATION line ".repeat(20000)+"SENTINEL-END")'`
  const bigOutput = (): FixtureAdapter => {
    let step = 0
    return {
      provider: 'scripted', model: 'fixture', capabilities: { fixture: { contextWindowTokens: 1_000_000 } },
      chat: async ({ messages = [] }: ChatRequest): Promise<ChatResponse> => {
        assertToolProtocol(messages)
        return step++ === 0 ? { toolCalls: [{ id: 'big', name: 'bash', arguments: { command } }] } : { content: 'done' }
      },
    }
  }
  // 落盘才能读回结果形态：runFixtureTask 只在给出 sessionDirectory 时持久化事件。
  const capturedResult = async (mode: ToolOutputMode) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eval-tool-output-'))
    try {
      await runFixtureTask('boundary', bigOutput, { ...evalPolicy, maxModelRequests: 8 }, directory, mode)
      const [session] = await fs.readdir(directory)
      const log = await fs.readFile(path.join(directory, session!, 'events.jsonl'), 'utf8')
      return log.trim().split('\n').map(line => JSON.parse(line) as SessionEvent)
        .filter(event => event.type === 'tool/result').map(event => event.data.content).join('')
    } finally { await fs.rm(directory, { recursive: true, force: true }) }
  }

  // 读回的是 CommandResult 的 JSON，命令原文也在里面（末尾哨兵因此在 command 字段出现一次）——要判断
  // 结果有没有被截断，必须看 stdout.text 而不是整段 JSON。
  const streamText = (content: string) => (JSON.parse(content) as { stdout: { text: string } }).stdout.text

  // 有界：结果被截成 8 KiB 预览 + 落盘引用，末尾哨兵留在存储里而不是历史里。
  const projected = JSON.parse(await capturedResult({ bounded: true })) as { stdout: { text: string; previewTruncated?: boolean; ref?: string } }
  assert.equal(projected.stdout.previewTruncated, true)
  assert.ok(projected.stdout.ref, 'a truncated stream must carry a ref back to the stored result')
  assert.ok(!projected.stdout.text.includes('SENTINEL-END'), 'the preview must not carry the tail of a large result')
  assert.ok(Buffer.byteLength(projected.stdout.text) <= 8192, `preview was ${Buffer.byteLength(projected.stdout.text)} bytes`)

  // 无界：同一段输出逐字进入历史，没有 previewTruncated 也没有 ref——这正是 NX-07 之前的行为，也是对照 B
  // 的基线臂。它同样说明「无界」不是把插件拆掉，而是把预览上限抬到任何单条结果都装得下。
  const unbounded = await capturedResult({ bounded: false })
  assert.ok(streamText(unbounded).endsWith('SENTINEL-END'))
  assert.ok(!unbounded.includes('previewTruncated'))
  assert.ok(Buffer.byteLength(streamText(unbounded)) > 200_000, `unbounded result was ${Buffer.byteLength(streamText(unbounded))} bytes`)
})

test('a stage summary reports a stage that never pruned without inventing evidence', () => {
  const summary = summarizeStage([
    projection(1, 1000, [], { requestId: 'q1' }), modelStart(2, 'q1'), modelUsage(3, 'q1', 'provider'),
    projection(4, 2000, [], { requestId: 'q2' }), modelStart(5, 'q2'), modelUsage(6, 'q2', 'provider'),
  ], 'run-1')
  assert.deepEqual(summary, {
    estimatedInputTokens: 2000, maxEstimatedInputTokens: 2000, projections: 2,
    firstPrunedProjection: null, removedTaskIds: [], unsentProjections: 0,
    usageSources: { provider: 2, estimated: 0 },
  })
})

// 裁剪一旦开始，estimatedInputTokens 就被钉在输入目标附近，看不出「本阶段自己长了多少」；最大值与
// 首次裁剪的投影序号正是为区分这两件事而记的，并集则给出被丢掉的是哪些旧任务。
test('a stage summary locates the first pruned projection and unions the removed task ids', () => {
  const summary = summarizeStage([
    projection(1, 1000, [], { requestId: 'q1' }), modelStart(2, 'q1'),
    projection(3, 2000, [], { requestId: 'q2' }), modelStart(4, 'q2'),
    projection(5, 66_000, ['old-a'], { requestId: 'q3' }), modelStart(6, 'q3'),
    projection(7, 65_500, ['old-a', 'old-b'], { requestId: 'q4' }), modelStart(8, 'q4'),
  ], 'run-1')
  assert.equal(summary.firstPrunedProjection, 3)
  assert.deepEqual(summary.removedTaskIds, ['old-a', 'old-b'])
  assert.equal(summary.estimatedInputTokens, 65_500)
  assert.equal(summary.maxEstimatedInputTokens, 66_000)
  assert.equal(summary.projections, 4)
})

// 三个边界：别的 run 的投影不算进本阶段；有投影但没有 model/start 的请求要单独计数（否则 context_overflow
// 会缺少「为何没有发出」的证据）；没有任何投影的阶段不编造 estimatedInputTokens。
test('a stage summary neither absorbs other runs nor hides projections that were never sent', () => {
  const summary = summarizeStage([
    projection(1, 1000, [], { requestId: 'q1' }), modelStart(2, 'q1'), modelUsage(3, 'q1', 'estimated'),
    projection(4, 70_000, ['old-a'], { requestId: 'q2' }),
    projection(5, 999_999, ['foreign'], { runId: 'run-2' }),
    projection(6, 80_000, ['old-a']),
  ], 'run-1')
  assert.equal(summary.unsentProjections, 1)
  assert.equal(summary.projections, 3)
  assert.deepEqual(summary.removedTaskIds, ['old-a'])
  assert.deepEqual(summary.usageSources, { provider: 0, estimated: 1 })
  assert.deepEqual(summarizeStage([], 'run-1'), {
    projections: 0, firstPrunedProjection: null, removedTaskIds: [], unsentProjections: 0,
    usageSources: { provider: 0, estimated: 0 },
  })
})

// 基础设施失败要么中止后续阶段，要么把同一个失败重复记成多份、而每一份都进入阶段累计用量——后者正是
// 要避免的。所以除了 error 与阶段数，这里还断言第三个阶段的正文一次都没有被下发。
test('an infrastructure failure stops the sequence instead of repeating it on every later stage', { timeout: 60_000 }, async () => {
  const reached = new Set<number>()
  const outcome = await runFixtureTask('pipeline', fixture => {
    const { chat } = scriptedAdapter(fixture)
    return {
      provider: 'failing', model: 'fixture', capabilities: { fixture: { contextWindowTokens: 1_000_000 } },
      chat: async (request: ChatRequest) => {
        const current = (request.messages ?? []).filter(message => message.role === 'user').at(-1)?.content ?? ''
        const at = fixture.tasks.indexOf(current)
        if (at >= 0) reached.add(at)
        if (at === 1) throw new Error('sandbox unavailable')
        return chat(request)
      },
    }
  }, driverBudget)
  assert.equal(outcome.error, 'sandbox unavailable')
  assert.deepEqual(outcome.tasks?.map(stage => stage.status), ['completed', 'error'])
  assert.deepEqual([...reached].sort(), [0, 1])
  // accepted 是工作区终态判定，与这次 run 是否基础设施失败是两件事：模拟适配器在第一个阶段就应用了
  // 全部参考改动，所以终态仍然通过。成功率口径把带 error 的 run 从分母排除，不接受它作为分子。
  assert.equal(outcome.accepted, true)
})

// 新增 fixture 不该悄悄挤掉筛查批次：清单与上限必须同步，否则 phaseCaps.screening.runs 会在第 13 个
// 计划任务之前中止阶段，12/12 的历史基线与旧上限就不再对应同一个任务集。
test('the screening cap still covers exactly the frozen screening batch', () => {
  assert.equal(phaseCaps.screening.runs, screeningIds.length)
  // 诊断阶段同理：它的 runs 按 fixture 运行次数计，因此必须等于该阶段 fixture 的个数。
  assert.equal(phaseCaps.sequence.runs, sequenceIds.length)
})

// 成功率口径：分子只数通过验收的 run；不可行任务与基础设施失败都从分母排除并各自单列，不能静默丢弃。
test('the success rate excludes infeasible tasks and infrastructure failures, keeping both countable', async () => {
  // 任务 0/1 通过、任务 2 未通过但可解、任务 3 基础设施失败、任务 4 不可行。
  const passed = new Set([0, 1, 4])
  const report = await runPhase('screening', tasks(5), phaseCaps.screening, async task => ({
    ...done(), accepted: passed.has(task.id), ...(task.id === 3 ? { error: 'connection reset' } : {}),
  }), record => (record.task.id === 4 ? { infeasible: true } : undefined))
  const summary = summarize(report)
  assert.equal(summary.accepted, 3)
  assert.equal(summary.rejected, 2)
  assert.equal(summary.infeasible, 1)
  assert.equal(summary.errored, 1)
  assert.deepEqual(summary.rate, { numerator: 2, denominator: 3, excludedInfeasible: 1, excludedErrored: 1 })
})

// 不可行是任务属性，不是验收结论的改写：即使某次 run 通过验收，被判定不可行也不进分子。
test('an infeasible run never enters the numerator even if its acceptance passed', async () => {
  const report = await runPhase('screening', tasks(2), phaseCaps.screening, async () => done(),
    record => (record.task.id === 0 ? { infeasible: true } : undefined))
  const summary = summarize(report)
  assert.equal(summary.accepted, 2)
  assert.deepEqual(summary.rate, { numerator: 1, denominator: 1, excludedInfeasible: 1, excludedErrored: 0 })
})

// 未结束的 run（accepted 为 null）既不在分子也不在分母之外：它仍占分母，且不计为通过。
test('a run with no verdict stays in the denominator without counting as a pass', async () => {
  const report = await runPhase('screening', tasks(2), phaseCaps.screening, async task => ({ ...done(), accepted: task.id === 0 ? null : true }))
  assert.deepEqual(summarize(report).rate, { numerator: 1, denominator: 2, excludedInfeasible: 0, excludedErrored: 0 })
})

test('a failing execution is recorded on its own run and does not abort the phase', async () => {
  const report = await runPhase('screening', tasks(3), phaseCaps.screening, async task => {
    if (task.id === 1) throw new Error('fixture workspace unavailable')
    return done()
  })
  assert.equal(report.executed.length, 3)
  assert.equal(report.aborted, null)
  assert.equal(report.executed[1].status, 'error')
  assert.equal(report.executed[1].error, 'fixture workspace unavailable')
  assert.deepEqual(report.executed[1].counters, counters(0, 0))
  const summary = summarize(report)
  assert.equal(summary.errored, 1)
  assert.equal(summary.completed, 2)
  assert.equal(summary.notExecuted, 0)
})
