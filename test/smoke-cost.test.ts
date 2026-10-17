import test from 'node:test'
import assert from 'node:assert/strict'
import { ModelStreamError } from '../src/core/model-error.js'
import { ModelNotDispatchedError } from '../src/core/model-dispatch.js'
import { createSmokeAmountGuard, peakUsageUsd, smokeReserveUsd } from '../scripts/smoke-cost.js'
import { selectSmokeScenarios } from '../scripts/smoke-plan.js'
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

test('repair-only reserve covers the capped tokens plus margin and one largest final request', async () => {
  const selected = selectSmokeScenarios('repair')
  const reserve = smokeReserveUsd(selected, price)
  assert.equal(reserve.tokenBudgetUsd, 0.24)
  assert.ok(Math.abs(reserve.marginUsd - 0.048) < 1e-12)
  assert.ok(Math.abs(reserve.finalRequestUsd - 0.3196608) < 1e-12)
  assert.ok(Math.abs(reserve.reserveUsd - 0.6076608) < 1e-12)
  let calls = 0
  const main = createSmokeAmountGuard(async () => { calls++; return { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, source: 'provider', uncertain: false } } }, price, 0.65)
  await main.chat(request)
  assert.equal(calls, 1)
  const summary = createSmokeAmountGuard(async () => { calls++; return { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, source: 'provider', uncertain: false } } }, price, 0.31)
  await summary.chat({ ...request, purpose: 'summary', maxOutputTokens: 8192 })
  assert.equal(calls, 2)
  const insufficient = createSmokeAmountGuard(async () => { calls++; return {} }, price, 0.3098)
  await assert.rejects(insufficient.chat({ ...request, purpose: 'summary', maxOutputTokens: 8192 }), /amount ceiling/)
  assert.equal(calls, 2)
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

test('network interruption after dispatch remains unknown and a nested pre-dispatch rejection does not', async () => {
  const interrupted = createSmokeAmountGuard(async () => { throw new Error('synthetic network disconnect') }, price, 1)
  await assert.rejects(interrupted.chat(request), /disconnect/)
  assert.equal(interrupted.calls, 1)
  assert.equal(interrupted.usageUnknown, true)
  const rejected = createSmokeAmountGuard(async () => { throw new ModelNotDispatchedError('synthetic request cap', 'request_limit') }, price, 1)
  await assert.rejects(rejected.chat(request), ModelNotDispatchedError)
  assert.equal(rejected.calls, 0)
  assert.equal(rejected.spentUsd, 0)
  assert.equal(rejected.usageUnknown, false)
})
