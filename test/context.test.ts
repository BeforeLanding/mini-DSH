import test from 'node:test'
import assert from 'node:assert/strict'
import { estimateInput, estimateText } from '../src/core/token-estimator.js'
import { harness } from './harness.js'
import { assertToolProtocol, groupHistory } from '../src/core/context-runtime.js'
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
