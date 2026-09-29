import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveBudget } from '../src/core/budget.js'
import { harness } from './harness.js'
import { assertToolProtocol } from '../src/core/context-runtime.js'
import { estimateInput } from '../src/core/token-estimator.js'
test('budget snapshots preserve zero, apply precedence and reject invalid values', () => {
  const input = { maxModelRequests: 3 }
  const policy = resolveBudget(input, { maxModelRequests: 0 })
  input.maxModelRequests = 9
  assert.equal(policy.maxModelRequests, 0)
  assert.ok(Object.isFrozen(policy))
  for (const value of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => resolveBudget({ maxToolCalls: value }))
  assert.throws(() => resolveBudget({ maxOutputTokens: 0 }))
  assert.throws(() => resolveBudget({ contextWindowTokens: 100 }))
})
test('invalid budget is rejected before user history or model dispatch', async () => {
  let calls = 0
  const h = harness(async () => { calls++; return { content: 'ok' } })
  const before = structuredClone(h.session.events)
  await assert.rejects(h.agent.send('test', { budget: { maxModelRequests: NaN } }), /invalid budget/)
  assert.equal(calls, 0)
  assert.deepEqual(h.session.events, before)
  assert.equal(await h.agent.send('test', { budget: { maxModelRequests: 2 } }), 'ok')
})
test('run completion, error and cancellation each seal exactly one terminal event', async () => {
  const h = harness(async () => ({ content: 'ok', reasoningContent: 'reasoning' }))
  await h.agent.send('first')
  const first = h.sessions.latestRun(h.session.id)!
  assert.equal(first.status, 'completed')
  assert.equal(first.counters.modelRequests, 1)
  assert.equal(h.sessions.deriveMessages(h.session.id).at(-1)?.reasoning_content, 'reasoning')
  const abort = new AbortController(); abort.abort()
  await assert.rejects(h.agent.send('second', { signal: abort.signal }), /cancelled/i)
  assert.equal(h.sessions.latestRun(h.session.id)?.status, 'cancelled')
  const dispose = h.llm.register('broken', { chat: async () => { throw new Error('failure') } })
  h.agent.model = 'broken/demo'
  await assert.rejects(h.agent.send('third'), /failure/)
  dispose()
  const last = h.sessions.latestRun(h.session.id)!
  assert.equal(last.status, 'error')
  assert.equal(last.counters.modelRequests, 1)
  h.sessions.finishRun(last, 'completed')
  assert.equal(h.session.events.filter(e => e.type === 'run/finish').length, 3)
  assert.deepEqual(h.session.events.map(e => e.seq), h.session.events.map((_, i) => i + 1))
  assert.equal(new Set(h.session.events.map(e => e.id)).size, h.session.events.length)
  h.sessions.clear(h.session.id)
  assert.equal(h.sessions.latestRun(h.session.id), undefined)
  assert.deepEqual(h.sessions.deriveMessages(h.session.id), [])
})
test('zero and N model budgets dispatch exact counts, while the last text answer completes', async () => {
  let calls = 0, executions = 0
  const h = harness(async () => { calls++; return { toolCalls: [{ id: `c${calls}`, name: 'tick', arguments: {} }] } })
  h.tools.register({ name: 'tick', execute: () => { executions++; return 'ok' } })
  await assert.rejects(h.agent.send('zero', { budget: { maxModelRequests: 0 } }), /max_steps/)
  assert.equal(calls, 0)
  await assert.rejects(h.agent.send('two', { budget: { maxModelRequests: 2 } }), /max_steps/)
  assert.equal(calls, 2)
  assert.equal(executions, 1)
  assert.equal(h.sessions.latestRun(h.session.id)?.counters.toolCalls, 1)
  assertToolProtocol(h.sessions.deriveMessages(h.session.id))
  const dispose = h.llm.register('final', { chat: async () => ({ content: 'answer' }) })
  h.agent.model = 'final/demo'
  assert.equal(await h.agent.send('final', { budget: { maxModelRequests: 1 } }), 'answer')
  assert.equal(h.sessions.latestRun(h.session.id)?.counters.modelRequests, 1)
  dispose()
})
test('a batch with one tool allowance executes only the first and pairs all skipped results', async () => {
  let executions = 0
  const h = harness(async () => ({ toolCalls: ['a', 'b', 'c'].map(id => ({ id, name: 'fail', arguments: {} })) }))
  h.tools.register({ name: 'fail', execute: () => { executions++; throw new Error('rejected operation') } })
  await assert.rejects(h.agent.send('batch', { budget: { maxModelRequests: 3, maxToolCalls: 1 } }), /max_tool_calls/)
  assert.equal(executions, 1)
  const results = h.session.events.filter(e => e.type === 'tool/result')
  assert.deepEqual(results.map(e => e.data.status), ['completed', 'skipped', 'skipped'])
  assert.equal(h.sessions.latestRun(h.session.id)?.counters.toolCalls, 1)
  assertToolProtocol(h.sessions.deriveMessages(h.session.id))
})
test('runtime defaults, agent limits and call overrides obey precedence per run', async () => {
  const h = harness(async () => ({ content: 'ok' }))
  h.loop.budget = { maxModelRequests: 0 }
  await assert.rejects(h.agent.send('runtime'), /max_steps/)
  h.agent.budget = { maxModelRequests: 1 }
  assert.equal(await h.agent.send('agent'), 'ok')
  await assert.rejects(h.agent.send('override', { budget: { maxModelRequests: 0 } }), /max_steps/)
  assert.equal(await h.agent.send('independent'), 'ok')
  assert.equal(h.sessions.latestRun(h.session.id)?.counters.modelRequests, 1)
})
test('cumulative tokens reserve input/output, lower output allowance and stop further dispatch', async () => {
  let calls = 0, executions = 0, output: number | undefined
  const h = harness(async request => {
    calls++; output = request.maxOutputTokens
    return { toolCalls: [{ id: 'a', name: 'tick', arguments: {} }], usage: { inputTokens: 500, outputTokens: 100, totalTokens: 600, source: 'provider', uncertain: false } }
  })
  h.tools.register({ name: 'tick', execute: () => { executions++; return 'ok' } })
  await assert.rejects(h.agent.send('zero', { budget: { maxTotalTokens: 0 } }), /token_budget/)
  assert.equal(calls, 0)
  const input = estimateInput({ system: '', messages: [{ role: 'user', content: 'current' }], tools: h.tools.schemas() })
  h.sessions.clear(h.session.id)
  await assert.rejects(h.agent.send('current', { budget: { maxTotalTokens: input + 10, maxOutputTokens: 100, minimumOutputTokens: 1 } }), /token_budget/)
  assert.equal(output, 10)
  assert.equal(calls, 1)
  assert.equal(executions, 0)
  assert.equal(h.sessions.latestRun(h.session.id)?.counters.totalTokens, 600)
  assertToolProtocol(h.sessions.deriveMessages(h.session.id))
})
test('repeated input is billed on each request and estimated usage participates in the limit', async () => {
  let calls = 0
  const h = harness(async () => { calls++; return { toolCalls: [{ id: `c${calls}`, name: 'tick', arguments: {} }] } })
  h.tools.register({ name: 'tick', execute: () => 'ok' })
  await assert.rejects(h.agent.send('current', { budget: { maxTotalTokens: 1800, maxOutputTokens: 20, minimumOutputTokens: 1 } }), /token_budget/)
  const state = h.sessions.latestRun(h.session.id)!
  assert.ok(calls >= 2)
  assert.equal(state.usage.length, calls)
  assert.ok(state.usage.every(u => u.source === 'estimated' && u.uncertain))
  assert.equal(state.counters.totalTokens, state.usage.reduce((sum, u) => sum + u.totalTokens, 0))
  assertToolProtocol(h.sessions.deriveMessages(h.session.id))
})
test('stop precedence is cancellation, active time, corresponding count, token then context', async () => {
  const h = harness(async () => ({ content: 'never' }))
  const budget = { maxModelRequests: 0, maxTotalTokens: 0, contextWindowTokens: 1, maxOutputTokens: 1 }
  const abort = new AbortController(); abort.abort()
  await assert.rejects(h.agent.send('mock', { budget, signal: abort.signal }), /cancelled/)
  await assert.rejects(h.agent.send('mock', { budget: { ...budget, maxActiveDurationMs: 0 } }), /timeout/)
  await assert.rejects(h.agent.send('mock', { budget }), /max_steps/)
  await assert.rejects(h.agent.send('mock', { budget: { ...budget, maxModelRequests: 1 } }), /token_budget/)
})
