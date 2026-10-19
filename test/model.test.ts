import test from 'node:test'
import assert from 'node:assert/strict'
import { createDeepSeekAdapter, normalizeUsage } from '../src/models/deepseek.js'
import { ModelStreamError, ProviderError } from '../src/core/model-error.js'
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
test('DeepSeek exposes parsed provider stream events for controlled smoke recording', async () => {
  const observed: unknown[] = []
  const adapter = createDeepSeekAdapter({ apiKey: 'mock', fetch: async () => new Response(
    event({ model: 'deepseek-flash', choices: [{ delta: { tool_calls: [{ index: 0, id: 'p', function: { name: 'echo_probe', arguments: '{"value":"OK"}' } }] } }] }) +
    event({ model: 'deepseek-flash', choices: [{ finish_reason: 'tool_calls', delta: {} }], usage }) + 'data: [DONE]\n',
  ) })
  const result = await adapter.chat({ onProviderEvent: item => observed.push(item) })
  assert.equal(result.observedModel, 'deepseek-flash')
  assert.equal(result.finishReason, 'tool_calls')
  assert.equal(result.toolCalls?.[0]?.name, 'echo_probe')
  assert.equal(observed.length, 2)
  assert.equal((observed[0] as { choices: { delta: { tool_calls: unknown[] } }[] }).choices[0].delta.tool_calls.length, 1)
  assert.deepEqual((observed[1] as { usage: unknown }).usage, usage)
})
test('malformed provider results and duplicate tool IDs fail with a single terminal state', async () => {
  const h = harness(async () => ({ toolCalls: [{ id: 'same', name: 'write', arguments: {} }, { id: 'same', name: 'write', arguments: {} }] }))
  let effects = 0
  h.tools.register({ name: 'write', execute: () => { effects++; return 'ok' } })
  await assert.rejects(h.agent.send('mock'), /invalid model response/)
  assert.equal(effects, 0)
  assert.equal(h.sessions.latestRun(h.session.id)?.status, 'error')
  assert.equal(h.session.events.filter(e => e.type === 'run/finish').length, 1)
  const adapter = createDeepSeekAdapter({ apiKey: 'mock', fetch: async () => new Response(event({ choices: [{ delta: { content: 123 } }] }) + 'data: [DONE]\n') })
  await assert.rejects(adapter.chat({}), /invalid SSE delta/)
})

test('DeepSeek classifies HTTP and transport failures without exposing provider bodies', async () => {
  const secret = 'fake-secret-token-401'
  for (const [status, body, kind, retryable] of [
    [401, `invalid key ${secret}`, 'auth', false],
    [429, `rate limit ${secret}`, 'rate_limit', true],
    [400, `maximum context length ${secret}`, 'context_overflow', false],
    [503, `upstream ${secret}`, 'transient', true],
  ] as const) {
    const adapter = createDeepSeekAdapter({ apiKey: 'mock', fetch: async () => new Response(body, { status, headers: { 'x-request-id': 'safe-request-1' } }) })
    await assert.rejects(adapter.chat({}), (error: unknown) => {
      assert.ok(error instanceof ProviderError)
      assert.equal(error.kind, kind)
      assert.equal(error.status, status)
      assert.equal(error.retryable, retryable)
      assert.equal(error.providerRequestId, 'safe-request-1')
      assert.doesNotMatch(error.message + JSON.stringify(error), /fake-secret-token/)
      return true
    })
  }
  const network = createDeepSeekAdapter({ apiKey: 'mock', fetch: async () => { throw new TypeError(`connection failed ${secret}`) } })
  await assert.rejects(network.chat({}), (error: unknown) => error instanceof ProviderError && error.kind === 'transient' && error.retryable && !error.message.includes(secret))
})

test('provider stream error text cannot appear in the surfaced exception', async () => {
  const adapter = createDeepSeekAdapter({ apiKey: 'mock', fetch: async () => new Response(event({ error: { message: 'fake-secret-token-stream' } }) + 'data: [DONE]\n') })
  await assert.rejects(adapter.chat({}), (error: unknown) => error instanceof ModelStreamError && !error.message.includes('fake-secret-token-stream'))
})
