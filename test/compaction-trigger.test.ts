import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AgentLoopRuntime } from '../src/core/agent-loop-runtime.js'
import { AgentRuntime } from '../src/core/agent-runtime.js'
import { resolveBudget } from '../src/core/budget.js'
import type { BudgetPolicy } from '../src/core/budget.js'
import type { Adapter, ChatRequest, ChatResponse, ToolCall } from '../src/core/contracts.js'
import { JsonlStore } from '../src/core/event-store.js'
import { readHistory } from '../src/core/history-read.js'
import { LlmRuntime } from '../src/core/llm-runtime.js'
import { ProviderError } from '../src/core/model-error.js'
import { SessionRuntime } from '../src/core/session-runtime.js'
import { SystemPromptRuntime } from '../src/core/system-prompt-runtime.js'
import { ToolRuntime } from '../src/core/tool-runtime.js'
import { harness } from './harness.js'
import { structuredSummary } from './structured-summary.js'

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
function scripted(steps: readonly ToolCall[], summarize: () => ChatResponse = () => ({ content: structuredSummary('Read the early range.') })) {
  const state = { calls: 0, summaries: 0, requests: [] as { kind: 'main' | 'summary'; request: ChatRequest }[] }
  let step = 0
  return {
    state,
    chat: (async (request: ChatRequest): Promise<ChatResponse> => {
      if (isSummaryCall(request)) { state.summaries += 1; state.requests.push({ kind: 'summary', request }); return summarize() }
      state.calls += 1
      state.requests.push({ kind: 'main', request })
      return step < steps.length ? { toolCalls: [steps[step++]!] } : { content: 'done' }
    }) as Adapter['chat'],
  }
}

const OLD_TASK_MARK = 'older task context'
const messagesText = (request: ChatRequest) => (request.messages ?? []).map(message => String(message.content ?? '')).join('\n')
const carriesOldTask = (request: ChatRequest) => messagesText(request).includes(OLD_TASK_MARK)
// 摘要之后的主请求序列：第 0 条是「摘要前」，其余的每一条都必须在裁剪后发出。
const mainRequestsAfterSummary = (requests: readonly { kind: 'main' | 'summary'; request: ChatRequest }[]) => {
  const summary = requests.findIndex(item => item.kind === 'summary')
  assert.ok(summary >= 0, 'the target case must actually summarize')
  return requests.slice(summary + 1).filter(item => item.kind === 'main').map(item => item.request)
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

function seedPriorTask(h: H, policy: BudgetPolicy) {
  const run = h.sessions.beginRun(h.session.id, policy, 'mock/test')
  h.sessions.append(h.session.id, 'user/message', { content: 'previous completed task' }, run)
  h.sessions.append(h.session.id, 'assistant/tool_calls', { toolCalls: [{ id: 'old', name: 'read_file', arguments: { path: 'old.txt' } }] }, run)
  h.sessions.append(h.session.id, 'tool/result', { toolCallId: 'old', name: 'read_file', content: 'older task context '.repeat(1800) }, run)
  h.sessions.finishRun(run, 'completed')
  return run
}

// 当前 task 的第一条 user/message 永不被摘要遮蔽：把它本身做到越线，就能构造一个
// 「摘要生效但仍高于压力线」的不可约前缀，用来继续钉住压缩反馈抑制。
function seedIrreducibleCurrent(h: H, policy: BudgetPolicy, userChars: number, tailChars = 16) {
  const run = h.sessions.beginRun(h.session.id, policy, 'mock/test')
  h.sessions.append(h.session.id, 'user/message', { content: 'x'.repeat(userChars) }, run)
  h.sessions.append(h.session.id, 'assistant/tool_calls', { toolCalls: [{ id: 'tail', name: 'read_file', arguments: { path: 'tail.txt' } }] }, run)
  h.sessions.append(h.session.id, 'tool/result', { toolCallId: 'tail', name: 'read_file', content: 't'.repeat(tailChars) }, run)
  h.sessions.append(h.session.id, 'assistant/message', { content: 'tail' }, run)
  h.sessions.finishRun(run, 'max_steps')
  return run
}

test('budget policy carries compaction knobs and rejects values outside their domain', () => {
  const policy = resolveBudget({ compactionRatio: 0.8, retainRatio: 0.16, postCompactionTargetRatio: 0.65, auto: true, compactionBudgetTokens: 1000, maxOverflowRetries: 0 })
  assert.equal(policy.compactionRatio, 0.8)
  assert.equal(policy.retainRatio, 0.16)
  assert.equal(policy.postCompactionTargetRatio, 0.65)
  assert.equal(policy.auto, true)
  assert.equal(policy.maxOverflowRetries, 0)
  for (const value of [0, -0.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) assert.throws(() => resolveBudget({ compactionRatio: value }), /fraction/)
  for (const value of [0, 2]) assert.throws(() => resolveBudget({ retainRatio: value }), /fraction/)
  for (const value of [0, 2]) assert.throws(() => resolveBudget({ postCompactionTargetRatio: value }), /fraction/)
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

test('a pressure summary prunes completed old tasks from the request that follows it', async () => {
  const steps: ToolCall[] = [1, 2, 3].map(index => ({ id: `tick-${index}`, name: 'tick', arguments: {} }))
  const scriptedRun = scripted(steps)
  const h = harness(scriptedRun.chat)
  h.tools.register({ name: 'tick', execute: () => 'current task output '.repeat(300) })
  const policy = base({ maxModelRequests: 10 })
  const prior = seedPriorTask(h, policy)

  assert.equal(await h.agent.send('new task', { budget: policy }), 'done')
  // 摘要仍先发生：摘要请求里旧任务不在规划范围内（规划器只看当前 task），
  // 所以摘要之后的主请求才是裁剪生效后的。摘要前的主请求必须还看得到旧任务，否则本用例
  // 证明的就不是「裁掉」而是「本来就没有」。
  const mainBefore = scriptedRun.state.requests.filter(item => item.kind === 'main')
  assert.ok(mainBefore.length >= 2)
  assert.equal(carriesOldTask(mainBefore[0]!.request), true)
  const afterSummary = mainRequestsAfterSummary(scriptedRun.state.requests)
  assert.ok(afterSummary.length >= 2, 'the run must continue for more than one turn after pruning')
  assert.ok(afterSummary.every(request => !carriesOldTask(request)), 'the pruned task must not return on a later turn')

  assert.ok(starts(h).length >= 1)
  assert.ok(scriptedRun.state.summaries >= 1)
  const finished = h.sessions.latestRun(h.session.id)!
  assert.ok(finished.removedTaskIds.includes(prior.taskId))
  const pruned = projections(h).find(event => event.data.removedTaskIds.includes(prior.taskId))
  assert.ok(pruned && pruned.data.estimatedInputTokens <= 3000 * 0.65)
  assert.equal(finished.status, 'completed')
})

test('pruning survives /continue and restart while the raw events stay readable', async () => {
  const steps: ToolCall[] = [1, 2, 3, 4, 5].map(index => ({ id: `tick-${index}`, name: 'tick', arguments: {} }))
  const scriptedRun = scripted(steps)
  const h = harness(scriptedRun.chat)
  h.tools.register({ name: 'tick', execute: () => 'current task output '.repeat(300) })
  // 3 次请求：两条摘要前主请求 + 摘要本身用掉最后一次额度，run 在裁剪决定落盘后停止。
  // 这覆盖最容易退化的续跑边界：摘要之后没有同 run 的下一轮，/continue 仍必须继承裁剪。
  const policy = base({ maxModelRequests: 3 })
  seedPriorTask(h, policy)
  const oldTaskEnd = h.session.events.at(-1)!.seq
  const oldResultSeq = h.session.events.find(event => event.type === 'tool/result' && event.data.content.includes(OLD_TASK_MARK))!.seq

  await assert.rejects(h.agent.send('new task', { budget: policy }), /max_steps/)
  const firstRun = scriptedRun.state.requests
  const summaryIndex = firstRun.findIndex(item => item.kind === 'summary')
  assert.ok(summaryIndex >= 0)
  assert.equal(firstRun.slice(summaryIndex + 1).length, 0, 'the summary itself must exhaust the run request budget')

  // /continue 开新 run，但同一个 task 与同一份事件日志：裁剪决定不能因为换了 run 就消失。
  const beforeContinue = scriptedRun.state.requests.length
  await assert.rejects(h.agent.continue({ budget: base({ maxToolCalls: 0 }) }), /max_tool_calls/)
  const continued = scriptedRun.state.requests.slice(beforeContinue)
  assert.ok(continued.some(item => item.kind === 'main'))
  assert.ok(continued.filter(item => item.kind === 'main').every(item => !carriesOldTask(item.request)))

  // 真实重启：写盘、关店、重新 restore，再继续一次。投影仍必须排除旧任务。
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-nx51-'))
  try {
    const store = await JsonlStore.open(root, h.session.id)
    h.sessions.attachStore(h.session.id, store)
    await h.sessions.flush(h.session.id)
    await store.close()

    const reopened = await JsonlStore.open(root, h.session.id)
    const restored = new SessionRuntime()
    await restored.restore(reopened)
    const tools = new ToolRuntime()
    tools.register({ name: 'tick', execute: () => 'current task output '.repeat(300) })
    const llm = new LlmRuntime()
    llm.register('mock', { models: ['test'], chat: scriptedRun.chat })
    const loop = new AgentLoopRuntime({ sessions: restored, tools, llm, systemPrompt: new SystemPromptRuntime() })
    const agent = new AgentRuntime().create({ sessionId: h.session.id, model: 'mock/test', loop })

    const beforeRestart = scriptedRun.state.requests.length
    await assert.rejects(agent.continue({ budget: base({ maxToolCalls: 0 }) }), /max_tool_calls/)
    const restarted = scriptedRun.state.requests.slice(beforeRestart)
    assert.ok(restarted.some(item => item.kind === 'main'))
    assert.ok(restarted.filter(item => item.kind === 'main').every(item => !carriesOldTask(item.request)))

    // 「保留原始事件」不是一句承诺：被裁掉的旧阶段仍在日志里，并且经 read_history 逐字可读。
    assert.ok(restored.visibleEvents(h.session.id).some(event => event.type === 'tool/result' && event.data.content.includes(OLD_TASK_MARK)))
    const history = readHistory(restored, h.session.id, oldResultSeq, oldTaskEnd)
    assert.match(history.content, /older task context/)
    await reopened.close()
  } finally {
    await h.sessions.close().catch(() => {})
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()))
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('agent loop retries a failed summary before the main request without repeating compaction', async () => {
  let summaryCalls = 0, mainCalls = 0
  const h = harness(async request => {
    if (isSummaryCall(request)) {
      summaryCalls++
      if (summaryCalls === 1) throw new ProviderError('rate_limit', 429, true)
      return { content: structuredSummary('Read the early range.') }
    }
    mainCalls++
    return { content: 'done' }
  })
  h.loop.random = () => 0
  const policy = base({ maxModelRequests: 4 })
  seed(h, policy)
  assert.equal(await h.agent.continue({ budget: policy }), 'done')
  assert.equal(summaryCalls, 2)
  assert.equal(mainCalls, 1)
  assert.equal(starts(h).length, 1)
  assert.equal(ends(h).length, 1)
  assert.equal(events(h).filter(event => event.type === 'model/retry').length, 1)
  assert.equal(h.sessions.latestRun(h.session.id)?.counters.modelRequests, 3)
})

test('pressure does not repeatedly summarize a prefix that stays above the pressure line', async () => {
  const steps: ToolCall[] = [1, 2, 3].map(index => ({ id: `tick-${index}`, name: 'tick', arguments: {} }))
  const scriptedRun = scripted(steps)
  const h = harness(scriptedRun.chat)
  h.tools.register({ name: 'tick', execute: () => 'current task output '.repeat(800) })
  const policy = base({ maxModelRequests: 10 })
  seedIrreducibleCurrent(h, policy, 30_000)

  assert.equal(await h.agent.continue({ budget: policy }), 'done')
  assert.equal(starts(h).length, 1)
  assert.equal(starts(h)[0]!.data.trigger, 'pressure')
  assert.equal(scriptedRun.state.summaries, 1)
  assert.equal(scriptedRun.state.calls, 4)
  const projected = projections(h)
  const afterPressure = projected.find((event, index) => index > 0 && event.data.requestId === projected[index - 1]!.data.requestId)
  assert.ok(afterPressure && afterPressure.data.estimatedInputTokens > 3000 * 0.8, 'summary cannot shrink the protected first user message')
  const suppressed = events(h).filter(event => event.type === 'context/pressure-suppressed')
  assert.equal(suppressed.length, 1)
  assert.equal(suppressed[0]?.type === 'context/pressure-suppressed' && suppressed[0].data.targetTokens, 1950)
  assert.equal(h.sessions.latestRun(h.session.id)?.status, 'completed')
})

test('pressure can run again after an effective summary and new history growth', async () => {
  const steps: ToolCall[] = [1, 2, 3].map(index => ({ id: `tick-${index}`, name: 'tick', arguments: {} }))
  const scriptedRun = scripted(steps)
  const h = harness(scriptedRun.chat)
  h.tools.register({ name: 'tick', execute: () => 'new output '.repeat(2200) })
  const policy = base({ maxModelRequests: 12 })
  seed(h, policy)

  assert.equal(await h.agent.continue({ budget: policy }), 'done')
  assert.ok(scriptedRun.state.summaries >= 2, 'effective compaction must not disable later pressure checks')
  assert.equal(events(h).filter(event => event.type === 'context/pressure-suppressed').length, 0)
  assert.equal(h.sessions.latestRun(h.session.id)?.status, 'completed')
})

test('a 52k–65k irreducible prefix records hysteresis and does not resummarize each turn', async () => {
  const scriptedRun = scripted([1, 2, 3].map(index => ({ id: `wide-${index}`, name: 'tick', arguments: {} })))
  const h = harness(scriptedRun.chat)
  h.tools.register({ name: 'tick', execute: () => 'small result' })
  const policy = base({ inputTargetTokens: 65_536, compactionBudgetTokens: 65_536, maxModelRequests: 10 })
  // 首条用户消息本身已越过压力线且不可遮蔽；尾部留一段可压缩内容，确保摘要真的会发生。
  seedIrreducibleCurrent(h, policy, 180_000, 30_000)

  assert.equal(await h.agent.continue({ budget: policy }), 'done')
  const suppressed = events(h).filter(event => event.type === 'context/pressure-suppressed')
  assert.equal(starts(h).length, 1)
  assert.equal(suppressed.length, 1)
  assert.equal(suppressed[0]?.type === 'context/pressure-suppressed' && suppressed[0].data.targetTokens, Math.floor(65_536 * 0.65))
  assert.equal(scriptedRun.state.summaries, 1)
  assert.equal(h.sessions.latestRun(h.session.id)?.status, 'completed')
})

test('overflow fallback remains available after ineffective pressure is suppressed', async () => {
  const scriptedRun = scripted([1, 2, 3].map(index => ({ id: `tick-${index}`, name: 'tick', arguments: {} })))
  const h = harness(scriptedRun.chat)
  let calls = 0
  h.tools.register({ name: 'tick', execute: () => ++calls < 3 ? 'current task output '.repeat(800) : 'new output '.repeat(36000) })
  const policy = base({ maxModelRequests: 10 })
  seedPriorTask(h, policy)

  assert.equal(await h.agent.send('new task', { budget: policy }), 'done')
  assert.deepEqual(starts(h).map(event => event.data.trigger), ['pressure', 'context-overflow'])
  assert.equal(h.sessions.latestRun(h.session.id)?.status, 'completed')
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
    if (isSummaryCall(request)) { if (failing) throw new Error('provider exploded'); return { content: structuredSummary('Read the early range.') } }
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
    if (isSummaryCall(request)) return { content: structuredSummary('Read the early range.') }
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
  const h = harness(async (request: ChatRequest) => isSummaryCall(request) ? { content: structuredSummary('Read the early range.') } : { content: 'should not happen' })
  const policy = base({ maxModelRequests: 1 })
  seed(h, policy)

  await assert.rejects(h.agent.continue({ budget: policy }), /max_steps/)
  assert.equal(starts(h).length, 1, '摘要确实跑过')
  assert.equal(h.sessions.latestRun(h.session.id)?.status, 'max_steps')
})
