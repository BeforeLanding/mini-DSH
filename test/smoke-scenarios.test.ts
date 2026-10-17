import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runRepairSmoke, runSmokeScenario } from '../scripts/smoke-scenarios.js'
import { smokeScenarios, selectSmokeScenarios, smokeBudget } from '../scripts/smoke-plan.js'
import { ModelNotDispatchedError } from '../src/core/model-dispatch.js'
import { createSmokeReplay, restoreSmokeFixture } from '../scripts/smoke-recording.js'
import { createHarness } from '../src/app/create-harness.js'
import type { SmokeManifest } from '../scripts/smoke-manifest.js'

const manifest = { codeSHA: 'a'.repeat(40), digest: 'b'.repeat(64), model: 'offline', modelVersionLabel: 'DeepSeek-V4.1-Flash-1017', toolSchemaSha256: 'c'.repeat(64),
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

test('selected repair dispatch creates no protocol or recall evidence', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-repair-selected-'))
  try {
    const adapter = { chat: async () => ({ content: 'synthetic stop', complete: true, finishReason: 'stop', usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7, source: 'provider' as const, uncertain: false } }) }
    for (const scenario of selectSmokeScenarios('repair')) await runSmokeScenario({ manifest, evidenceRoot: root, runtimeRoot: root, adapter }, scenario)
    assert.deepEqual(await fs.readdir(root), ['repair'])
    const recording = path.join(root, 'repair', 'recording.jsonl')
    const rows = (await fs.readFile(recording, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(rows.map(row => row.kind), ['header', 'start', 'end'])
    assert.equal(rows[1].fingerprint.length, 64)
    assert.equal(rows[2].response.usage.source, 'provider')
    assert.equal(rows[2].response.finishReason, 'stop')
    const restored = path.join(root, 'restored')
    restoreSmokeFixture(recording, restored)
    const replay = createSmokeReplay({ file: recording, workspace: restored, version: rows[0].version, wire: rows[0].wire })
    await replay.chat(rows[1].request)
    replay.assertConsumed()
    await assert.rejects(replay.chat(rows[1].request), /no API fallback/)
    const systemLines = rows[1].request.system.split('\n') as string[]
    const recordedTime = systemLines.find(line => line.startsWith('Time: '))!.slice(6)
    const projectLine = systemLines[systemLines.indexOf('## Project Context') + 3]!
    const recordedProjectWorkspace = JSON.parse(projectLine).workspace as string
    const fullReplay = createSmokeReplay({ file: recording, workspace: restored, version: rows[0].version, wire: rows[0].wire, recordedProjectWorkspace })
    const harness = await createHarness({ workspace: restored, profile: 'coding', autoApprove: true, runtimeTime: () => recordedTime,
      commandRunner: async () => { throw new Error('offline test forbids command execution') },
      adapter: { provider: 'deepseek', model: 'offline', capabilities: { offline: { contextWindowTokens: 1_000_000 } }, chat: fullReplay.chat } })
    try {
      const scenario = selectSmokeScenarios('repair')[0]!
      const session = harness.root.sessions.create({ source: 'offline-replay', fixtureId: scenario.fixture })
      const budget = smokeBudget(scenario)
      const agent = harness.root.agents.create({ sessionId: session.id, model: 'deepseek/offline', loop: harness.root.agentLoop, budget })
      const task = await fs.readFile(path.join(import.meta.dirname, '..', '..', 'test', 'fixtures', 'coding', 'repair', 'TASK.md'), 'utf8')
      await agent.send(task, { budget })
      fullReplay.assertConsumed()
      assert.equal(harness.root.sessions.latestRun(session.id)?.status, 'completed')
      assert.equal(harness.root.sessions.visibleEvents(session.id).filter(event => event.type === 'tool/start').length, 0)
    } finally { await harness.dispose() }
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
