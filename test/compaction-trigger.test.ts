import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveBudget } from '../src/core/budget.js'
import type { BudgetPolicy } from '../src/core/budget.js'
import type { Adapter, ChatRequest, ChatResponse, ToolCall } from '../src/core/contracts.js'
import { harness } from './harness.js'

// 压缩预算刻意与输入目标解耦：这样压力触发可以独立于溢出触发被检验。默认配置下两者等价
// （compactionBudgetTokens 默认取 inputTargetTokens），那正是 §4.1 要如实写下来的事情。
const base = (overrides: BudgetPolicy = {}): BudgetPolicy => ({
  contextWindowTokens: 1_000_000, maxOutputTokens: 1000, minimumOutputTokens: 1,
  inputTargetTokens: 100_000, compactionBudgetTokens: 3000, compactionRatio: 0.8, retainRatio: 0.1,
  ...overrides,
})

const SUMMARY_MARK = '上面的对话正在被摘要'
const isSummaryCall = (request: ChatRequest) => typeof request.messages?.at(-1)?.content === 'string' && request.messages!.at(-1)!.content!.includes(SUMMARY_MARK)

// 脚本化模型：摘要调用与主循环调用要能分开认。摘要调用一眼可辨——它的最后一条消息就是固定指令。
function scripted(steps: readonly ToolCall[], summarize: () => ChatResponse = () => ({ content: 'early range summary' })) {
  const state = { calls: 0, summaries: 0 }
  let step = 0
  return {
    state,
    chat: (async (request: ChatRequest): Promise<ChatResponse> => {
      if (isSummaryCall(request)) { state.summaries += 1; return summarize() }
      state.calls += 1
      return step < steps.length ? { toolCalls: [steps[step++]!] } : { content: 'done' }
    }) as Adapter['chat'],
  }
}

type H = ReturnType<typeof harness>
const events = (h: H) => h.sessions.visibleEvents(h.session.id)
const starts = (h: H) => events(h).flatMap(event => event.type === 'context/summary-start' ? [event] : [])
const ends = (h: H) => events(h).flatMap(event => event.type === 'context/summary-end' ? [event] : [])
const projections = (h: H) => events(h).flatMap(event => event.type === 'context/projection' ? [event] : [])
const runStarts = (h: H) => events(h).flatMap(event => event.type === 'run/start' ? [event] : [])
const runFinishes = (h: H) => events(h).flatMap(event => event.type === 'run/finish' ? [event] : [])

// 播一段「一条原始请求 + 一条大工具结果 + 一条尾巴」的历史，再把当前 run 停在 max_steps 上：
// 随后的 continue 会复用同一个 taskId，于是压缩压的正是当前 task 自己——单任务长会话，
// 也就是本项存在的理由（既有裁剪对当前 task 恒受保护，救不了的就是它）。
function seed(h: H, policy: BudgetPolicy, resultChars = 20_000) {
  const run = h.sessions.beginRun(h.session.id, policy, 'mock/test')
  h.sessions.append(h.session.id, 'user/message', { content: 'original request: never edit src/secret.ts' }, run)
  h.sessions.append(h.session.id, 'assistant/tool_calls', { toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'a.ts' } }] }, run)
  h.sessions.append(h.session.id, 'tool/result', { toolCallId: 'c1', name: 'read_file', content: 'x'.repeat(resultChars) }, run)
  h.sessions.append(h.session.id, 'assistant/message', { content: 'tail' }, run)
  h.sessions.finishRun(run, 'max_steps')
  return run
}

test('budget policy carries compaction knobs and rejects values outside their domain', () => {
  const policy = resolveBudget({ compactionRatio: 0.8, retainRatio: 0.16, auto: true, compactionBudgetTokens: 1000, maxOverflowRetries: 0 })
  assert.equal(policy.compactionRatio, 0.8)
  assert.equal(policy.retainRatio, 0.16)
  assert.equal(policy.auto, true)
  assert.equal(policy.maxOverflowRetries, 0)
  for (const value of [0, -0.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) assert.throws(() => resolveBudget({ compactionRatio: value }), /fraction/)
  for (const value of [0, 2]) assert.throws(() => resolveBudget({ retainRatio: value }), /fraction/)
  assert.throws(() => resolveBudget({ auto: 1 as unknown as boolean }), /boolean/)
  assert.throws(() => resolveBudget({ compactionBudgetTokens: 0 }), /positive/)
})

test('pressure compacts a fitting projection that has crossed the compaction ratio', async () => {
  const scriptedRun = scripted([])
  const h = harness(scriptedRun.chat)
  const policy = base()
  seed(h, policy)

  assert.equal(await h.agent.continue({ budget: policy }), 'done')
  assert.equal(starts(h).length, 1)
  assert.equal(starts(h)[0]!.data.trigger, 'pressure')
  assert.equal(h.sessions.latestRun(h.session.id)?.status, 'completed')
  // 压缩后重新投影，且两条投影准备的是同一个请求。
  assert.equal(projections(h).length, 2)
  assert.equal(new Set(projections(h).map(event => event.data.requestId)).size, 1)
})

test('overflow compacts and retries instead of stopping, and records both projections', async () => {
  const scriptedRun = scripted([])
  const h = harness(scriptedRun.chat)
  const policy = base({ inputTargetTokens: 3000 })
  seed(h, policy)

  assert.equal(await h.agent.continue({ budget: policy }), 'done')
  assert.equal(starts(h)[0]!.data.trigger, 'context-overflow')
  // 压缩没有让输入变小的话这里会是 context_overflow——那正是 R-22 允许的退路，但不是这个场景。
  assert.equal(h.sessions.latestRun(h.session.id)?.status, 'completed')
  assert.equal(projections(h).length, 2)
  assert.equal(new Set(projections(h).map(event => event.data.requestId)).size, 1)
})

test('auto false turns both automatic triggers off without changing where the run stops', async () => {
  const scriptedRun = scripted([])
  const h = harness(scriptedRun.chat)
  const policy = base({ inputTargetTokens: 3000, auto: false })
  seed(h, policy)

  await assert.rejects(h.agent.continue({ budget: policy }), /context_overflow/)
  assert.deepEqual(starts(h), [])
  assert.equal(scriptedRun.state.summaries, 0)
  assert.equal(h.sessions.latestRun(h.session.id)?.status, 'context_overflow')
})

test('maxOverflowRetries zero declines the overflow fallback', async () => {
  const scriptedRun = scripted([])
  const h = harness(scriptedRun.chat)
  const policy = base({ inputTargetTokens: 3000, maxOverflowRetries: 0 })
  seed(h, policy)

  await assert.rejects(h.agent.continue({ budget: policy }), /context_overflow/)
  assert.deepEqual(starts(h), [])
})

test('the failure latch counts only summary failures and stops the automatic path', async () => {
  // 三轮工具调用 = 四次循环迭代，每次迭代都落在压力带里：前两次各记一次失败，之后被闩挡住。
  const steps: ToolCall[] = [1, 2, 3].map(index => ({ id: `c${index}`, name: 'read_file', arguments: { path: `${index}.ts` } }))
  const scriptedRun = scripted(steps, () => { throw new Error('provider exploded') })
  const h = harness(scriptedRun.chat)
  const policy = base({ maxSummaryFailures: 2 })
  seed(h, policy)

  assert.equal(await h.agent.continue({ budget: policy }), 'done')
  assert.equal(starts(h).length, 2, '两次失败之后闩必须挡住后续自动尝试')
  assert.equal(scriptedRun.state.summaries, 2)
  assert.deepEqual(ends(h).map(event => event.data.outcome),
    [{ kind: 'declined', reason: 'summary-failed' }, { kind: 'declined', reason: 'summary-failed' }])
  // 主循环照常跑完：压缩失败不改变这次 run 的结局。
  assert.equal(h.sessions.latestRun(h.session.id)?.status, 'completed')
})

test('explicit compaction is exempt from the latch and opens a maintenance run on the same task', async () => {
  const steps: ToolCall[] = [1, 2, 3].map(index => ({ id: `c${index}`, name: 'read_file', arguments: { path: `${index}.ts` } }))
  let failing = true
  const h = harness((async (request: ChatRequest): Promise<ChatResponse> => {
    if (isSummaryCall(request)) { if (failing) throw new Error('provider exploded'); return { content: 'early range summary' } }
    const step = steps.shift()
    return step ? { toolCalls: [step] } : { content: 'done' }
  }) as Adapter['chat'])
  const policy = base({ maxSummaryFailures: 1 })
  const seeded = seed(h, policy)
  assert.equal(await h.agent.continue({ budget: policy }), 'done')
  assert.equal(starts(h).length, 1, '闩在一次失败之后就合上了')

  failing = false
  assert.equal(await h.loop.compact(h.agent, { budget: policy }), true, 'explicit 不受闩影响')
  assert.equal(starts(h).at(-1)!.data.trigger, 'explicit')
  const maintenance = runStarts(h).filter(event => event.data.state.maintenance)
  assert.equal(maintenance.length, 1)
  assert.equal(maintenance[0]!.data.state.taskId, seeded.taskId, '维护型 run 复用当前 task')
  assert.equal(maintenance[0]!.data.state.previousRunId, undefined, '维护型 run 不进续跑链')
  const finished = runFinishes(h).find(event => event.data.state.runId === maintenance[0]!.data.state.runId)
  assert.equal(finished!.data.state.status, 'completed')
  // 摘要调用照样记账：这一段 run 自己 1 次请求、1 条 usage。
  assert.equal(finished!.data.state.counters.modelRequests, 1)
  assert.equal(finished!.data.state.usage.length, 1)
})

test('a maintenance run does not cost the task its ability to continue', async () => {
  const h = harness(async () => ({ content: 'done' }))
  const policy = base()
  const seeded = seed(h, policy)
  await h.loop.compact(h.agent, { budget: policy })

  // 关键回归：一次 /compact 之后「预算停止还能续跑」必须仍然成立——若维护型 run 进了续跑链，
  // beginRun 会看着它那条 completed 直接报 “task already completed”。
  assert.equal(h.sessions.latestRun(h.session.id)?.maintenance, true)
  assert.equal(await h.agent.continue({ budget: policy }), 'done')
  const continued = h.sessions.latestRun(h.session.id)!
  assert.equal(continued.taskId, seeded.taskId)
  assert.equal(continued.previousRunId, seeded.runId, '续跑承接的是最后一次真正干活的 run')
})

test('a declined compaction is recorded with a closed-set reason and re-projection stays honest', async () => {
  const scriptedRun = scripted([], () => ({ content: '   ' }))
  const h = harness(scriptedRun.chat)
  const policy = base({ inputTargetTokens: 3000 })
  seed(h, policy)

  await assert.rejects(h.agent.continue({ budget: policy }), /context_overflow/)
  assert.deepEqual(ends(h).map(event => event.data.outcome), [{ kind: 'declined', reason: 'summary-empty' }])
  // 摘要没落地，所以投影只有压缩前那一条，且 run 以 context_overflow 结束（R-22 允许的退路）。
  assert.equal(projections(h).length, 1)
  assert.equal(h.sessions.latestRun(h.session.id)?.status, 'context_overflow')
})

test('a summary call consumes the run model-request budget like any other request', async () => {
  let mainCalls = 0
  const h = harness(async (request: ChatRequest) => {
    if (isSummaryCall(request)) return { content: 'early range summary' }
    mainCalls += 1
    return { content: 'done' }
  })
  const policy = base({ maxModelRequests: 2 })
  seed(h, policy)

  assert.equal(await h.agent.continue({ budget: policy }), 'done')
  assert.equal(mainCalls, 1)
  const state = h.sessions.latestRun(h.session.id)!
  assert.equal(state.counters.modelRequests, 2, '一次摘要 + 一次回答')
  assert.equal(state.usage.length, 2)
})

test('a summary call that exhausts the request budget stops the run before dispatching the main request', async () => {
  const h = harness(async (request: ChatRequest) => isSummaryCall(request) ? { content: 'early range summary' } : { content: 'should not happen' })
  const policy = base({ maxModelRequests: 1 })
  seed(h, policy)

  await assert.rejects(h.agent.continue({ budget: policy }), /max_steps/)
  assert.equal(starts(h).length, 1, '摘要确实跑过')
  assert.equal(h.sessions.latestRun(h.session.id)?.status, 'max_steps')
})
