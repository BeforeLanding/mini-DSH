import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveBudget } from '../src/core/budget.js'
import { harness } from './harness.js'
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
