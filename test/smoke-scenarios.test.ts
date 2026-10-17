import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runRepairSmoke } from '../scripts/smoke-scenarios.js'
import { smokeScenarios } from '../scripts/smoke-plan.js'
import { ModelNotDispatchedError } from '../src/core/model-dispatch.js'
import type { SmokeManifest } from '../scripts/smoke-manifest.js'

const manifest = { codeSHA: 'a'.repeat(40), digest: 'b'.repeat(64), model: 'offline', toolSchemaSha256: 'c'.repeat(64),
  wire: { provider: 'deepseek', baseUrl: 'https://api.deepseek.com', thinking: 'enabled', sampling: 'provider-default', stream: true, includeUsage: true } } as unknown as SmokeManifest

test('repair smoke saves and independently assesses a stopped candidate after an offline request refusal', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-repair-smoke-'))
  try {
    const scenario = smokeScenarios.find(item => item.id === 'repair')!
    const result = await runRepairSmoke({ manifest, evidenceRoot: root, runtimeRoot: root, adapter: {
      models: ['offline'], capabilities: { offline: { contextWindowTokens: 1_000_000 } },
      chat: async () => { throw new ModelNotDispatchedError('synthetic request ceiling', 'request_limit') },
    } }, scenario)
    assert.equal(result.status, 'failed')
    assert.equal(result.runStatus, 'max_steps')
    assert.equal(result.evidenceStatus, 'saved')
    assert.equal(result.artifactAcceptance, 'failed')
    assert.equal(result.runErrorType, 'BudgetStop')
    assert.deepEqual(result.counts, { main: 0, summary: 0 })
    assert.equal((await fs.stat(path.join(root, 'repair', 'candidate', 'src', 'cart.mjs'))).isFile(), true)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('repair smoke distinguishes a completed model run from failing artifact acceptance', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-repair-smoke-'))
  try {
    const scenario = smokeScenarios.find(item => item.id === 'repair')!
    const result = await runRepairSmoke({ manifest, evidenceRoot: root, runtimeRoot: root, adapter: {
      models: ['offline'], capabilities: { offline: { contextWindowTokens: 1_000_000 } },
      chat: async () => ({ content: 'synthetic done', complete: true, finishReason: 'stop', usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7, source: 'provider', uncertain: false } }),
    } }, scenario)
    assert.equal(result.status, 'failed')
    assert.equal(result.runStatus, 'completed')
    assert.equal(result.evidenceStatus, 'saved')
    assert.equal(result.artifactAcceptance, 'failed')
    assert.equal(result.runErrorType, null)
    assert.deepEqual(result.counts, { main: 1, summary: 0 })
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
