import test from 'node:test'
import assert from 'node:assert/strict'
import { runPhase, summarize, phaseCaps, batchCaps, singleRunBudget, evalPolicy, capKeys } from '../scripts/eval-runner.js'
import type { RunOutcome } from '../scripts/eval-runner.js'
import { runFixtureTask, scriptedAdapter } from '../scripts/eval-fixture.js'
import { CLI_BUDGET } from '../src/core/budget.js'
import type { Counters } from '../src/core/budget.js'

const counters = (modelRequests: number, totalTokens: number): Counters =>
  ({ modelRequests, toolCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens, activeDurationMs: 0, approvalDurationMs: 0 })
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
