import test from 'node:test'
import assert from 'node:assert/strict'
import { createDeepSeekAdapter, normalizeUsage } from '../src/models/deepseek.js'
import { ModelStreamError } from '../src/core/model-error.js'
import { harness } from './harness.js'
const usage = { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18, completion_tokens_details: { reasoning_tokens: 3 } }
const event = (data: unknown) => 'data: ' + JSON.stringify(data) + '\n'
test('DeepSeek streams usage-only and repeated final chunks without duplicate accounting', async () => {
  let payload: Record<string, unknown> = {}
  const adapter = createDeepSeekAdapter({ apiKey: 'mock', fetch: async (_url, options) => {
    payload = JSON.parse(String(options?.body)) as Record<string, unknown>
    return new Response(event({ choices: [{ delta: { content: 'answer', reasoning_content: 'thinking' } }] }) + event({ choices: [{ finish_reason: 'stop', delta: {} }], usage }) + event({ choices: [], usage }) + 'data: [DONE]\n')
  } })
  const h = harness(request => adapter.chat(request))
  assert.equal(await h.agent.send('mock input', { budget: { maxOutputTokens: 100 } }), 'answer')
  assert.equal(payload.max_tokens, 100)
  assert.deepEqual(payload.stream_options, { include_usage: true })
  const state = h.sessions.latestRun(h.session.id)!
  assert.equal(state.usage.length, 1)
  assert.equal(state.counters.totalTokens, 18)
  assert.equal(state.usage[0].reasoningTokens, 3)
  assert.equal(state.usage[0].source, 'provider')
})
test('output length and malformed arguments never dispatch partial tools', async () => {
  let calls = 0
  const adapter = createDeepSeekAdapter({ apiKey: 'mock', fetch: async () => new Response(event({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'write', arguments: '{"x":' } }] }, finish_reason: 'length' }], usage }) + 'data: [DONE]\n') })
  const h = harness(request => adapter.chat(request))
  h.tools.register({ name: 'write', execute: () => { calls++; return 'ok' } })
  await assert.rejects(h.agent.send('mock'), /output_limit/)
  assert.equal(calls, 0)
  assert.equal(h.sessions.latestRun(h.session.id)?.counters.totalTokens, 18)
  assert.equal(h.sessions.latestRun(h.session.id)?.status, 'output_limit')
  const invalid = createDeepSeekAdapter({ apiKey: 'mock', fetch: async () => new Response(event({ choices: [{ delta: { tool_calls: [{ function: { name: 'write', arguments: '[' } }] }, finish_reason: 'tool_calls' }], usage }) + 'data: [DONE]\n') })
  await assert.rejects(invalid.chat({}), (error: unknown) => error instanceof ModelStreamError && error.partial.usage?.totalTokens === 18)
})
test('usage validation excludes cache/reasoning double counting and rejects invalid counts', () => {
  assert.equal(normalizeUsage({ ...usage, prompt_cache_hit_tokens: 10 })?.totalTokens, 18)
  assert.equal(normalizeUsage(null), undefined)
  assert.throws(() => normalizeUsage({ ...usage, total_tokens: 99 }), /usage/)
  assert.throws(() => normalizeUsage({ ...usage, completion_tokens: -1 }), /usage/)
})
