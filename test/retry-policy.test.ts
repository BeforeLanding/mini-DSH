import test from 'node:test'
import assert from 'node:assert/strict'
import { ProviderError, ModelStreamError } from '../src/core/model-error.js'
import { parseRetryAfter, retryDelay, waitForRetry } from '../src/core/retry-policy.js'
import { createDeepSeekAdapter } from '../src/models/deepseek.js'

test('Retry-After parses seconds and dates without accepting malformed or unbounded values', () => {
  const now = Date.parse('2026-10-20T00:00:00Z')
  assert.equal(parseRetryAfter('2', now), 2000)
  assert.equal(parseRetryAfter('Tue, 20 Oct 2026 00:00:04 GMT', now), 4000)
  assert.equal(parseRetryAfter('Tue, 20 Oct 2026 00:00:00 GMT', now), 0)
  assert.equal(parseRetryAfter('-1', now), undefined)
  assert.equal(parseRetryAfter('not a date', now), undefined)
  assert.equal(parseRetryAfter('9'.repeat(200), now), undefined)
})

test('retry policy limits attempts and delay to remaining time and rejects auth or partial streams', () => {
  const rate = new ProviderError('rate_limit', 429, true, undefined, 1500)
  assert.equal(retryDelay(rate, 0, 2000, () => 0.5), 1500)
  assert.equal(retryDelay(rate, 0, 1500, () => 0), undefined)
  assert.equal(retryDelay(rate, 2, 5000), undefined)
  assert.equal(retryDelay(new ProviderError('transient', 503, true), 1, 5000, () => 0.5), 500)
  assert.equal(retryDelay(new ProviderError('transient', undefined, true), 0, 5000, () => 0.5), 250)
  assert.equal(retryDelay(new ProviderError('auth', 401), 0, 5000), undefined)
  assert.equal(retryDelay(new ProviderError('invalid_request', 400), 0, 5000), undefined)
  assert.equal(retryDelay(new ModelStreamError('partial', { content: 'x', complete: false }), 0, 5000), undefined)
})

test('DeepSeek captures Retry-After as safe metadata without exposing response body', async () => {
  const adapter = createDeepSeekAdapter({ apiKey: 'mock', fetch: async () => new Response('fake-secret-token', { status: 429, headers: { 'retry-after': '3' } }) })
  await assert.rejects(adapter.chat({ model: 'mock', messages: [], signal: new AbortController().signal }), error => {
    assert.ok(error instanceof ProviderError)
    assert.equal(error.retryAfterMs, 3000)
    assert.doesNotMatch(error.message, /fake-secret-token/)
    return true
  })
})

test('retry wait clears its timer when cancelled', async () => {
  const controller = new AbortController()
  let cleared = false
  const clock = { now: () => 0, setTimeout: () => 1, clearTimeout: () => { cleared = true } }
  const pending = waitForRetry(1000, controller.signal, clock)
  controller.abort(new Error('cancelled'))
  await assert.rejects(pending, /cancelled/)
  assert.equal(cleared, true)
})
