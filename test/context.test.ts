import test from 'node:test'
import assert from 'node:assert/strict'
import { estimateInput, estimateText } from '../src/core/token-estimator.js'
import { harness } from './harness.js'
import { requestTrace } from '../src/core/task-trace.js'
import { assertToolProtocol, groupHistory, ContextBudgetRuntime } from '../src/core/context-runtime.js'
test('token estimator covers Unicode, schemas, reasoning and protocol envelope', () => {
  assert.equal(estimateText('abc'), 1)
  assert.equal(estimateText('中文🙂'), 3)
  assert.equal(estimateText('const x = 1'), 4)
  const base = estimateInput({ messages: [{ role: 'user', content: 'hello' }] })
  assert.ok(base > 288)
  assert.ok(estimateInput({ system: 'policy', messages: [{ role: 'assistant', content: null, reasoning_content: 'reasoning' }] }) > base)
  assert.ok(estimateInput({ tools: [{ type: 'function', function: { name: 'tool', description: 'schema', parameters: { description: '中'.repeat(5000) } } }] }) > 5000)
})
test('history groups entire tasks including multiple runs and never splits pending tools', async () => {
  const h = harness(async () => ({ content: 'answer' }))
  await h.agent.send('first')
  const first = h.sessions.latestRun(h.session.id)!
  await h.agent.send('second')
  const second = h.sessions.latestRun(h.session.id)!
  const before = structuredClone(h.session.events)
  const groups = groupHistory(h.sessions.visibleEvents(h.session.id), second.taskId)
  assert.deepEqual(groups.map(g => g.taskId), [first.taskId, second.taskId])
  assert.equal(groups[0].complete, true)
  assert.equal(groups[0].protected, false)
  assert.equal(groups[1].protected, true)
  assert.deepEqual(h.session.events, before)
  assertToolProtocol(h.sessions.deriveMessages(h.session.id))
  assert.throws(() => assertToolProtocol([{ role: 'tool', content: 'orphan', tool_call_id: 'x' }]), /orphan/)
  const run = h.sessions.beginRun(h.session.id, {}, 'mock/demo')
  h.sessions.append(h.session.id, 'assistant/tool_calls', { toolCalls: [{ id: 'pending', name: 'tool', arguments: {} }] }, run)
  h.sessions.finishRun(run, 'error')
  const pending = groupHistory(h.sessions.visibleEvents(h.session.id), second.taskId).at(-1)!
  assert.equal(pending.protected, true)
  assert.throws(() => assertToolProtocol(h.sessions.deriveMessages(h.session.id)), /missing tool result/)
})
test('projections carry the id of the request they prepared and an overflowed request keeps its id unsent', async () => {
  const h = harness(async () => ({ content: 'answer' }))
  await h.agent.send('old-context '.repeat(100))
  const projections = () => h.session.events.filter(event => event.type === 'context/projection')
  const starts = () => h.session.events.filter(event => event.type === 'model/start')
  assert.equal(projections().length, 1)
  assert.equal(projections()[0].data.requestId, starts()[0].data.requestId)
  const trace = requestTrace(h.sessions, h.session.id)
  assert.equal(trace.requests[0].projectionLink, 'requestId')
  assert.equal(trace.requests[0].projection?.requestId, starts()[0].data.requestId)
  assert.deepEqual(trace.unsentProjections, [])
  assert.equal(trace.requests[0].counters?.modelRequests, 1)
  assert.equal(trace.requests[0].counters?.toolCalls, 0)
  assert.ok((trace.requests[0].counters?.totalTokens ?? 0) > 0)
  assert.ok((trace.requests[0].counters?.activeDurationMs ?? -1) >= 0)
  const sent = starts().length
  const fullInput = estimateInput({ system: '', tools: [], messages: [...h.sessions.deriveMessages(h.session.id), { role: 'user', content: 'current' }] })
  await assert.rejects(h.agent.send('current', { budget: {
    contextWindowTokens: fullInput + 2048 + 100 - 1, maxOutputTokens: 1000, minimumOutputTokens: 1, maxTotalTokens: fullInput + 100,
  } }), /context_overflow/)
  assert.equal(starts().length, sent)
  assert.equal(projections().length, sent + 1)
  const blocked = projections().at(-1)!
  assert.equal(typeof blocked.data.requestId, 'string')
  assert.ok(!starts().some(start => start.data.requestId === blocked.data.requestId))
  // 该请求属于溢出那次 run 的 task，因此不出现在按当前 task 分页的 requests 中，只能由 unsentProjections 体现。
  const after = requestTrace(h.sessions, h.session.id)
  assert.equal(after.total, 0)
  assert.deepEqual(after.unsentProjections.map(projection => projection.requestId), [blocked.data.requestId])
})

test('missing usage and interrupted streams record estimated nonzero consumption', async () => {
  const h = harness(async ({ onContent }) => { onContent?.('partial'); throw new Error('network interrupted') })
  await assert.rejects(h.agent.send('mock input'), /interrupted/)
  const state = h.sessions.latestRun(h.session.id)!
  assert.equal(state.usage.length, 1)
  assert.equal(state.usage[0].source, 'estimated')
  assert.equal(state.usage[0].uncertain, true)
  assert.ok(state.counters.totalTokens > 0)
  assert.equal(h.sessions.deriveMessages(h.session.id).length, 1)
  assert.ok(h.session.events.some(e => e.type === 'model/fragment' && e.data.content === 'partial'))
  const done = h.llm.register('complete', { chat: async () => ({ content: 'answer' }) })
  h.agent.model = 'complete/demo'
  await h.agent.send('next')
  assert.equal(h.sessions.latestRun(h.session.id)?.usage[0].source, 'estimated')
  done()
})
test('request projection drops oldest complete tasks, preserves raw events and current task', async () => {
  const h = harness(async () => ({ content: 'answer' }))
  await h.agent.send('oldest '.repeat(200))
  const oldest = h.sessions.latestRun(h.session.id)!.taskId
  await h.agent.send('middle '.repeat(200))
  const middle = h.sessions.latestRun(h.session.id)!.taskId
  await h.agent.send('current')
  const current = h.sessions.latestRun(h.session.id)!.taskId
  const before = structuredClone(h.session.events)
  const project = () => new ContextBudgetRuntime().project(h.sessions.visibleEvents(h.session.id), current, { system: 'mandatory policy', maxOutputTokens: 10 },
    { contextWindowTokens: 4000, inputTargetTokens: 500 }, events => h.sessions.deriveMessages(h.session.id, events))
  const result = project()
  assert.deepEqual(result.removedTaskIds, [oldest, middle])
  assert.equal(result.messages[0].content, 'current')
  assert.ok(result.fits)
  assert.deepEqual(project(), result)
  assert.deepEqual(h.session.events, before)
})
test('capacity equality dispatches, one token below stops, and model capacity is recomputed', async () => {
  let calls = 0
  const h = harness(async () => { calls++; return { content: 'ok' } })
  const input = estimateInput({ system: '', messages: [{ role: 'user', content: 'current' }], tools: [] })
  const exact = input + 10 + 2048
  await h.agent.send('current', { budget: { contextWindowTokens: exact, maxOutputTokens: 10 } })
  assert.equal(calls, 1)
  h.sessions.clear(h.session.id)
  await assert.rejects(h.agent.send('current', { budget: { contextWindowTokens: exact - 1, maxOutputTokens: 10 } }), /context_overflow/)
  assert.equal(calls, 1)
  assert.equal(h.sessions.latestRun(h.session.id)?.status, 'context_overflow')
  assert.equal(h.sessions.latestRun(h.session.id)?.estimatedInputTokens, input)
  const dispose = h.llm.register('capacity', { models: ['large', 'small'], capabilities: { large: { contextWindowTokens: 10000 }, small: { contextWindowTokens: 100 } }, chat: async () => { calls++; return { content: 'ok' } } })
  h.agent.budget = { inputTargetTokens: 5000, maxOutputTokens: 10 }
  h.agent.model = 'capacity/large'
  await h.agent.send('current')
  h.agent.model = 'capacity/small'
  await assert.rejects(h.agent.send('current'), /context_overflow/)
  assert.equal(calls, 2)
  h.agent.model = 'mock/test'
  const before = h.session.events.length
  await assert.rejects(h.agent.send('current'), /explicitly configured/)
  assert.equal(h.session.events.length, before)
  dispose()
})
test('oversized current input, system or schemas stop without a model request', async () => {
  for (const kind of ['input', 'system', 'schema']) {
    let calls = 0
    const h = harness(async () => { calls++; return { content: 'ok' } })
    if (kind === 'system') h.loop.systemPrompt = { assemble: async () => '中'.repeat(5000) }
    if (kind === 'schema') h.tools.register({ name: 'huge', parameters: { description: '中'.repeat(5000) }, execute: () => 'ok' })
    await assert.rejects(h.agent.send(kind === 'input' ? '中'.repeat(5000) : 'current', { budget: { contextWindowTokens: 4000, maxOutputTokens: 10 } }), /context_overflow/)
    assert.equal(calls, 0)
    assert.equal(h.sessions.latestRun(h.session.id)?.counters.modelRequests, 0)
  }
})

test('a session with several ended tasks drops only the oldest and keeps every raw event', async () => {
  let captured: import('../src/core/contracts.js').ChatRequest | undefined
  const h = harness(async request => { captured = request; return { content: 'answer' } })
  const stages = ['first stage '.repeat(200), 'second stage '.repeat(200), 'third stage']
  const taskIds: string[] = []
  for (const stage of stages.slice(0, 2)) {
    await h.agent.send(stage)
    taskIds.push(h.sessions.latestRun(h.session.id)!.taskId)
  }
  const before = structuredClone(h.session.events)
  // 容量只比「装下全部三个阶段」少 1 token，第三个任务因此必须裁掉最早的阶段才发得出去。
  // 这是对照 A 的触发形状：单任务会话无论多大都走不到这里，因为当前 task 恒受保护。
  const fullInput = estimateInput({ system: '', tools: [], messages: [...h.sessions.deriveMessages(h.session.id), { role: 'user', content: stages[2] }] })
  await h.agent.send(stages[2], { budget: { contextWindowTokens: fullInput + 2048 + 1000 - 1, maxOutputTokens: 1000, minimumOutputTokens: 1 } })
  taskIds.push(h.sessions.latestRun(h.session.id)!.taskId)
  const projection = h.session.events.filter(e => e.type === 'context/projection').at(-1)!
  assert.deepEqual(projection.data.removedTaskIds, [taskIds[0]])
  assert.equal(h.sessions.latestRun(h.session.id)?.status, 'completed')
  const sent = captured!.messages!.map(message => message.content ?? '').join('\n')
  assert.doesNotMatch(sent, /first stage/)
  assert.match(sent, /second stage/)
  assert.match(sent, /third stage/)
  // 裁剪只作用于请求投影：旧阶段的正文仍在原始事件里，/history 与恢复都还能读到。
  assert.deepEqual(h.session.events.slice(0, before.length), before)
  assertToolProtocol(h.sessions.deriveMessages(h.session.id))
})

test('projection uses remaining output allowance before trimming and recalculates after removal', async () => {
  for (const mode of ['exact', 'below', 'minimum', 'exhausted'] as const) {
    let captured: import('../src/core/contracts.js').ChatRequest | undefined
    let calls = 0
    const h = harness(async request => { captured = request; calls++; return { content: 'ok' } })
    await h.agent.send('old-context '.repeat(100))
    const oldTask = h.sessions.latestRun(h.session.id)!.taskId
    const before = structuredClone(h.session.events)
    const fullInput = estimateInput({ system: '', tools: [], messages: [...h.sessions.deriveMessages(h.session.id), { role: 'user', content: 'current' }] })
    const budget = {
      contextWindowTokens: fullInput + 2048 + 100 - (mode === 'below' ? 1 : 0),
      maxOutputTokens: 1000, minimumOutputTokens: mode === 'minimum' ? 101 : 1,
      maxTotalTokens: mode === 'exhausted' ? 0 : fullInput + 100,
    }
    if (mode === 'exhausted' || mode === 'below') {
      await assert.rejects(h.agent.send('current', { budget }), mode === 'exhausted' ? /token_budget/ : /context_overflow/)
      assert.equal(calls, 1)
      if (mode === 'below') {
        const projection = h.session.events.filter(e => e.type === 'context/projection').at(-1)!
        assert.deepEqual(projection.data.removedTaskIds, [oldTask])
        assert.equal(projection.data.reservedOutputTokens, budget.maxTotalTokens - projection.data.estimatedInputTokens)
      }
    } else {
      await h.agent.send('current', { budget })
      const projection = h.session.events.filter(e => e.type === 'context/projection').at(-1)!
      assert.equal(projection.type, 'context/projection')
      if (projection.type !== 'context/projection') throw new Error('missing projection')
      assert.deepEqual(projection.data.removedTaskIds, mode === 'exact' ? [] : [oldTask])
      assert.equal(captured!.messages!.length, mode === 'exact' ? 3 : 1)
      assert.equal(captured!.maxOutputTokens, budget.maxTotalTokens - projection.data.estimatedInputTokens)
      assert.equal(projection.data.reservedOutputTokens, captured!.maxOutputTokens)
      if (mode === 'exact') assert.equal(captured!.maxOutputTokens, 100)
      assert.ok(projection.data.estimatedInputTokens + projection.data.reservedOutputTokens + projection.data.safetyMarginTokens <= budget.contextWindowTokens)
    }
    assert.deepEqual(h.session.events.slice(0, before.length), before)
  }
})
