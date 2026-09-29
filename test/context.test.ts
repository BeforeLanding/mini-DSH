import test from 'node:test'
import assert from 'node:assert/strict'
import { estimateInput, estimateText } from '../src/core/token-estimator.js'
import { harness } from './harness.js'
test('token estimator covers Unicode, schemas, reasoning and protocol envelope', () => {
  assert.equal(estimateText('abc'), 1)
  assert.equal(estimateText('中文🙂'), 3)
  assert.equal(estimateText('const x = 1'), 4)
  const base = estimateInput({ messages: [{ role: 'user', content: 'hello' }] })
  assert.ok(base > 288)
  assert.ok(estimateInput({ system: 'policy', messages: [{ role: 'assistant', content: null, reasoning_content: 'reasoning' }] }) > base)
  assert.ok(estimateInput({ tools: [{ type: 'function', function: { name: 'tool', description: 'schema', parameters: { description: '中'.repeat(5000) } } }] }) > 5000)
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
