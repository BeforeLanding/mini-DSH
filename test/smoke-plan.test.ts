import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { smokeScenarios, smokeBudget, smokeTotalRequests, smokeTotalTokens, selectSmokeScenarios } from '../scripts/smoke-plan.js'
import { runProtocolSmoke, runRecallSmoke } from '../scripts/smoke-scenarios.js'
import { smokeWire, smokeModel, smokeModelVersionLabel, smokeProtocol, digestManifest, currentCodeSHA, currentToolSchemaSHA, smokeFixtureSourceSHA, verifySmokeManifest, type SmokeManifest } from '../scripts/smoke-manifest.js'
import type { Adapter } from '../src/core/contracts.js'

const syntheticUsage = { inputTokens: 20, outputTokens: 10, totalTokens: 30, source: 'provider' as const, uncertain: false }
const manifest: SmokeManifest = { protocol: smokeProtocol, digest: 'a'.repeat(64), codeSHA: 'b'.repeat(40), toolSchemaSha256: 'c'.repeat(64), fixtureSourceSha256: 'd'.repeat(64), model: smokeModel, modelVersionLabel: smokeModelVersionLabel, echoedModel: smokeModel, wire: smokeWire, scenarios: smokeScenarios,
  price: { source: 'official', capturedAt: '2026-10-17T00:00:00Z', currency: 'USD', peakCacheReadPerMillion: 0.006, peakInputPerMillion: 0.30, peakOutputPerMillion: 1.20 } }

test('the dedicated smoke schedule has fixed request, token, output and time ceilings', () => {
  assert.deepEqual(smokeScenarios.map(item => [item.id, item.maxMainRequests, item.maxSummaryRequests]), [['protocol', 2, 0], ['recall', 4, 1], ['repair', 6, 1]])
  assert.equal(smokeTotalRequests, 14)
  assert.equal(smokeTotalTokens, 520_000)
  for (const scenario of smokeScenarios) {
    const policy = smokeBudget(scenario)
    assert.equal(policy.maxModelRequests, scenario.maxMainRequests + scenario.maxSummaryRequests)
    assert.equal(policy.maxTotalTokens, scenario.maxTotalTokens)
    assert.equal(policy.maxOutputTokens, scenario.maxOutputTokens)
    assert.equal(policy.maxActiveDurationMs, scenario.maxActiveDurationMs)
    assert.equal(policy.requestTimeoutMs, scenario.requestTimeoutMs)
    assert.ok(scenario.maxWallDurationMs > scenario.maxActiveDurationMs)
  }
})

test('explicit selection fixes order and the manifest digest and rejects changed scenario fields', async () => {
  assert.deepEqual(selectSmokeScenarios('repair').map(item => item.id), ['repair'])
  for (const invalid of ['', 'repair,repair', 'repair,protocol', 'unknown', 'repair, recall']) assert.throws(() => selectSmokeScenarios(invalid))
  const { digest: _oldDigest, ...base } = { ...manifest, codeSHA: currentCodeSHA(), toolSchemaSha256: await currentToolSchemaSHA(), fixtureSourceSha256: smokeFixtureSourceSHA(), scenarios: selectSmokeScenarios('repair') }
  const selected = { ...base, digest: digestManifest(base) }
  await verifySmokeManifest(selected, 'repair')
  await assert.rejects(verifySmokeManifest(selected, 'protocol'), /mismatch/)
  const altered = { ...selected, scenarios: [{ ...selected.scenarios[0]!, maxMainRequests: 7 }] }
  const { digest: _discard, ...alteredBase } = altered
  altered.digest = digestManifest(alteredBase)
  await assert.rejects(verifySmokeManifest(altered, 'repair'), /mismatch/)
  assert.notEqual(selected.digest, digestManifest({ ...base, scenarios: smokeScenarios }))
})

test('scripted protocol probe records exactly two requests with no provider fallback', async () => {
  const evidenceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-smoke-protocol-'))
  try {
    let calls = 0
    const adapter: Adapter = { chat: async request => {
      calls++
      assert.equal(request.purpose, 'main')
      assert.equal(request.maxOutputTokens, 1024)
      return calls === 1 ? { content: 'OK', complete: true, finishReason: 'stop', observedModel: smokeModel, usage: syntheticUsage } :
        { content: '', complete: true, finishReason: 'tool_calls', observedModel: smokeModel, usage: syntheticUsage, toolCalls: [{ id: 'probe', name: 'echo_probe', arguments: { value: 'OK' } }] }
    } }
    const result = await runProtocolSmoke({ manifest, evidenceRoot, runtimeRoot: 'unused', adapter }, smokeScenarios[0]!)
    assert.equal(result.status, 'passed')
    assert.equal(calls, 2)
    const records = (await fs.readFile(path.join(evidenceRoot, 'protocol', 'recording.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(records.filter(item => item.kind === 'start').map(item => item.purpose), ['main', 'main'])
    assert.deepEqual(records.filter(item => item.kind === 'end').map(item => item.response.finishReason), ['stop', 'tool_calls'])
  } finally { await fs.rm(evidenceRoot, { recursive: true, force: true }) }
})

test('scripted history smoke consumes one summary before main calls and verifies event-number readback', async () => {
  const evidenceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-smoke-recall-'))
  try {
    let main = 0
    const adapter: Adapter = { chat: async request => {
      if (request.purpose === 'summary') return { content: '## Primary Request\nRemember the audit detail.\n## Next Step\nUse read_history to recover the marker.', complete: true, finishReason: 'stop', usage: syntheticUsage }
      main++
      if (main === 1) {
        const text = request.messages?.at(-1)?.content ?? ''
        const match = /event (\d+)/.exec(text)
        assert.ok(match)
        return { content: '', complete: true, finishReason: 'tool_calls', usage: syntheticUsage, toolCalls: [{ id: 'history', name: 'read_history', arguments: { from: Number(match[1]), to: Number(match[1]) } }] }
      }
      return { content: 'blue-lantern-7319', complete: true, finishReason: 'stop', usage: syntheticUsage }
    } }
    const result = await runRecallSmoke({ manifest, evidenceRoot, runtimeRoot: 'unused', adapter }, smokeScenarios[1]!)
    assert.equal(result.status, 'passed')
    assert.equal(result.readHistoryUsed, true)
    const records = (await fs.readFile(path.join(evidenceRoot, 'recall', 'recording.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(records.filter(item => item.kind === 'start').map(item => item.purpose), ['summary', 'main', 'main'])
  } finally { await fs.rm(evidenceRoot, { recursive: true, force: true }) }
})
