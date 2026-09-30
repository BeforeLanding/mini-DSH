import test from 'node:test'
import assert from 'node:assert/strict'
import { runPhase, summarize, phaseCaps, batchCaps, singleRunBudget, evalPolicy, capKeys } from '../scripts/eval-runner.js'
import type { RunOutcome } from '../scripts/eval-runner.js'
import { runFixtureTask, scriptedAdapter } from '../scripts/eval-fixture.js'
import { screeningIds } from '../scripts/coding-fixtures.js'
import { CLI_BUDGET } from '../src/core/budget.js'
import type { Counters } from '../src/core/budget.js'
import type { ChatRequest } from '../src/core/contracts.js'

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

test('pre-registered caps match PLAN and the phase caps sum to the whole-batch caps', () => {
  assert.deepEqual(singleRunBudget, { maxModelRequests: 32, maxToolCalls: 64, maxActiveDurationMs: 300_000, maxTotalTokens: 2_000_000 })
  assert.deepEqual(phaseCaps, {
    screening: { runs: 12, requests: 400, tokens: 8_000_000 },
    armA: { runs: 72, requests: 2_400, tokens: 45_000_000 },
    armB: { runs: 72, requests: 2_400, tokens: 45_000_000 },
  })
  for (const cap of capKeys) assert.equal(batchCaps[cap], phaseCaps.screening[cap] + phaseCaps.armA[cap] + phaseCaps.armB[cap], cap)
  // 单次预算不能替代整批上限：每个 run 都用满单次 token 预算时总量远超整批上限，正是 PLAN 要求独立整批上限的理由。
  assert.ok(batchCaps.runs * (singleRunBudget.maxTotalTokens ?? 0) > batchCaps.tokens)
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
  const outcome = await runFixtureTask('pipeline', scriptedAdapter)
  const stages = outcome.tasks ?? []
  assert.equal(stages.length, 6)
  // 每个阶段一次 send，各自拿到新的 taskId；先前结束的阶段因此才是可裁剪的旧任务。
  assert.equal(new Set(stages.map(stage => stage.taskId)).size, 6)
  assert.ok(stages.every(stage => stage.status === 'completed'))
  assert.equal(outcome.status, stages.at(-1)?.status)
  assert.equal(outcome.accepted, true)
  assert.equal(outcome.acceptance?.output.trim(), 'acceptance passed: pipeline')
  assert.equal(outcome.error, undefined)
  assert.deepEqual(outcome.counters, sumStages(stages.map(stage => stage.counters)))
  assert.ok(outcome.counters.modelRequests > stages.length, 'a sequence run costs more than one request per stage')
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
  })
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
