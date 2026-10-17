import test from 'node:test'
import assert from 'node:assert/strict'
import { ModelStreamError } from '../src/core/model-error.js'
import { createSmokeAmountGuard, peakUsageUsd } from '../scripts/smoke-cost.js'
import type { SmokeManifest } from '../scripts/smoke-manifest.js'

const price: SmokeManifest['price'] = { source: 'official', capturedAt: '2026-10-17T05:48:29Z', currency: 'USD', peakCacheReadPerMillion: 0.006, peakInputPerMillion: 0.30, peakOutputPerMillion: 1.20 }
const usage = { inputTokens: 100_000, outputTokens: 10_000, totalTokens: 110_000, cacheReadTokens: 20_000, source: 'provider' as const, uncertain: false }
const request = { purpose: 'main' as const, model: 'test', maxOutputTokens: 16_384, messages: [{ role: 'user' as const, content: 'synthetic' }] }

test('peak cost separates cache read, cache miss and output and reserves the next request', async () => {
  assert.equal(peakUsageUsd(usage, price), 0.08 * 0.30 + 0.02 * 0.006 + 0.01 * 1.20)
  let calls = 0
  const guarded = createSmokeAmountGuard(async () => { calls++; return { complete: true, finishReason: 'stop', usage } }, price, 0.35)
  await guarded.chat(request)
  assert.equal(guarded.spentUsd, 0.03612)
  await assert.rejects(guarded.chat(request), /amount ceiling cannot reserve/)
  assert.equal(calls, 1)
  assert.equal(guarded.calls, 1)
})

test('unknown usage and partial stream usage never become zero-cost retries', async () => {
  let calls = 0
  const missing = createSmokeAmountGuard(async () => { calls++; return { content: 'unknown' } }, price, 1)
  await missing.chat(request)
  await assert.rejects(missing.chat(request), /usage unknown/)
  assert.equal(missing.usageUnknown, true)
  assert.equal(calls, 1)
  const partial = createSmokeAmountGuard(async () => { throw new ModelStreamError('synthetic stream failure', { complete: false, usage }) }, price, 1)
  await assert.rejects(partial.chat(request), ModelStreamError)
  assert.equal(partial.spentUsd, 0.03612)
  assert.equal(partial.usageUnknown, false)
})
