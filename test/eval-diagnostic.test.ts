import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ChatRequest, ChatResponse } from '../src/core/contracts.js'
import type { SessionEvent } from '../src/core/contracts.js'
import type { Fixture } from '../scripts/eval-fixture.js'
import { diagnosticValue } from '../scripts/eval-diagnostic-fixture.js'
import { diagnosticSchedule, diagnosticReport, diagnosticReserve, freezeDiagnostic, observeDiagnostic, verifyDiagnosticManifest, diagnosticStopReason } from '../scripts/eval-diagnostic-plan.js'
import type { DiagnosticConfig } from '../scripts/eval-diagnostic-plan.js'
import { executeDiagnosticEpisodes } from '../scripts/eval-diagnostic-run.js'

const config: DiagnosticConfig = {
  model: 'deepseek/deepseek-flash', echoedModel: 'deepseek-flash', modelVersion: 'offline-test-version',
  thinking: 'enabled', sampling: 'provider-default', baseUrl: 'https://api.deepseek.com',
  priceSnapshot: { source: 'https://api-docs.deepseek.com/quick_start/pricing/', capturedAt: '2026-10-18T00:00:00Z',
    currency: 'USD', inputPerMillion: 0.30, outputPerMillion: 1.20, cacheReadPerMillion: 0.006 },
}

test('NX-51 schedule is fixed, paired, balanced and has the shared 1M reserve', () => {
  const rows = diagnosticSchedule()
  assert.equal(rows.length, 12)
  assert.equal(new Set(rows.map(row => `${row.bytes}/${row.repeat}/${row.arm}`)).size, 12)
  for (let index = 0; index < rows.length; index += 2) {
    const pair = rows.slice(index, index + 2)
    assert.deepEqual(pair.map(row => row.arm).sort(), ['baseline', 'full'])
    assert.equal(pair[0]!.bytes, pair[1]!.bytes)
    assert.equal(pair[0]!.repeat, pair[1]!.repeat)
  }
  assert.equal(rows.filter((row, index) => index % 2 === 0 && row.arm === 'baseline').length, 3)
  assert.ok(Math.abs(diagnosticReserve(config.priceSnapshot).batchUsd - 21.1355904) < 1e-9)
})

function scriptedDiagnostic(fixture: Fixture, fail: boolean) {
  let sentDiagnostic = false, sentEdit = false, sentCheck = false, value: string | undefined
  return async (request: ChatRequest): Promise<ChatResponse> => {
    if (fail) return { content: 'No diagnosis completed.' }
    const tool = request.messages?.filter(message => message.role === 'tool').at(-1)?.content ?? ''
    if (!sentDiagnostic) { sentDiagnostic = true; return { toolCalls: [{ id: 'diagnostic', name: 'bash', arguments: { command: 'node diagnostic.mjs' } }] } }
    if (!value) {
      value = /DIAGNOSTIC_VALUE=([a-f0-9]{20})/.exec(tool)?.[1]
      if (!value) {
        const result = JSON.parse(tool) as { stdout: { text: string; ref?: string } }
        const offset = Number(/DIAGNOSTIC_OFFSET=(\d+)/.exec(result.stdout.text)![1])
        assert.ok(result.stdout.ref)
        return { toolCalls: [{ id: 'read-diagnostic', name: 'read_tool_result', arguments: { ref: result.stdout.ref, offset, maxBytes: 128 } }] }
      }
    }
    if (!sentEdit) { sentEdit = true; return { toolCalls: [{ id: 'repair', name: 'edit_file', arguments: fixture.edits[0]! }] } }
    if (!sentCheck) { sentCheck = true; return { toolCalls: [{ id: 'check', name: 'bash', arguments: { command: 'node smoke.mjs' } }] } }
    return { content: `BC01 fixed. DIAGNOSTIC_VALUE=${value}` }
  }
}

test('NX-51 scripted full schedule records completion, real retrieval, budgets and a retained failure', { skip: !process.env.MINI_DSH_V2_RUNTIME }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nx51-offline-'))
  const evidenceRoot = path.join(root, 'evidence')
  try {
    const manifest = await freezeDiagnostic(config, 'a'.repeat(40))
    const result = await executeDiagnosticEpisodes({ manifest, evidenceRoot, runtimeRoot: process.env.MINI_DSH_V2_RUNTIME!, mode: 'offline',
      makeAdapter: (episode, fixture) => ({ provider: 'scripted', model: 'fixture', capabilities: { fixture: { contextWindowTokens: 1_000_000 } },
        chat: scriptedDiagnostic(fixture, episode.bytes === 4096 && episode.repeat === 2 && episode.arm === 'baseline') }) })
    assert.equal(result.stopped, false)
    assert.equal(result.records.length, 12)
    const rows = result.records
    assert.equal(rows.filter(row => row.reliable).length, 11)
    assert.equal(rows.filter(row => row.readToolCalls === 1).length, 3)
    assert.equal(rows.filter(row => row.observation.metrics.previewTruncations === 1).length, 3)
    for (const row of rows) {
      assert.ok(row.observation.metrics.mainRequests + row.observation.metrics.summaryRequests <= 64)
      assert.ok(row.observation.metrics.toolCalls <= 128)
      assert.ok(row.observation.metrics.inputTokens + row.observation.metrics.outputTokens <= 1_000_000)
      assert.equal(row.observation.acceptanceGroups.length, 4)
      if (row.reliable) { assert.equal(row.diagnosticExecuted, true); assert.equal(row.diagnosticBeforeEdit, true)
        assert.equal(row.diagnosticValueVisible, true); assert.equal(row.diagnosticReported, true); assert.equal(row.observation.accepted, true) }
    }
    const failed = rows.find(row => row.episode.repeat === 2 && row.episode.bytes === 4096 && row.episode.arm === 'baseline')!
    assert.equal(failed.diagnosticExecuted, false)
    assert.equal(failed.diagnosticReported, false)
    assert.equal(failed.observation.accepted, false)
    const report = diagnosticReport(manifest, rows)
    assert.equal(report.planned, 12); assert.equal(report.executed, 12); assert.deepEqual(report.missing, [])
    assert.equal(report.groups.reduce((total, group) => total + group.reliable, 0), 11)
    assert.equal((await fs.readFile(path.join(evidenceRoot, 'runs.jsonl'), 'utf8')).trim().split('\n').length, 12)
  } finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) }
})

test('NX-51 report preserves missing rows and diagnosis failure separately from artifact acceptance', async () => {
  const manifest = await freezeDiagnostic(config, 'a'.repeat(40))
  const episode = manifest.episodes[0]!
  const counters = { modelRequests: 1, toolCalls: 0, toolErrors: 0, previewTruncations: 0,
    inputTokens: 100, outputTokens: 10, totalTokens: 110, cacheReadTokens: 0, activeDurationMs: 1, approvalDurationMs: 0 }
  const record = observeDiagnostic(episode, {
    status: 'completed', counters,
    accepted: true, acceptance: { passed: true, exitCode: 0, output: '', protectedFilesChanged: [],
      groups: ['positive-offset-rollover', 'negative-offset-rollover', 'ordinary-day', 'empty-and-sort'].map(name => ({ name, passed: true })) },
  }, [], true, 120, config.priceSnapshot, false)
  assert.equal(record.observation.accepted, true)
  assert.equal(record.diagnosticExecuted, false)
  assert.equal(record.diagnosticValueVisible, false)
  assert.equal(record.reliable, false)
  const report = diagnosticReport(manifest, [record])
  assert.equal(report.executed, 1); assert.equal(report.missing.length, 11)
  assert.equal(report.groups[0]!.artifactAccepted, 1)
  assert.equal(report.groups[0]!.reliable, 0)
  assert.equal(report.groups[0]!.failureClasses.diagnostic_not_run, 1)
  assert.equal(diagnosticStopReason(record, []), null, 'ordinary diagnosis failure continues the batch')
  const guessed = observeDiagnostic(episode, {
    status: 'completed', counters, accepted: true,
    acceptance: { passed: true, exitCode: 0, output: '', protectedFilesChanged: [],
      groups: record.observation.acceptanceGroups },
  }, [
    { seq: 1, type: 'assistant/tool_calls', data: { toolCalls: [{ id: 'diag', name: 'bash', arguments: { command: 'node diagnostic.mjs' } }] } },
    { seq: 2, type: 'tool/result', data: { toolCallId: 'diag', name: 'bash', content: 'truncated preview', isError: false } },
    { seq: 3, type: 'assistant/message', data: { content: `DIAGNOSTIC_VALUE=${diagnosticValue(0)}` } },
  ] as SessionEvent[], true, 120, config.priceSnapshot, false)
  assert.equal(guessed.diagnosticExecuted, true)
  assert.equal(guessed.diagnosticReported, true)
  assert.equal(guessed.diagnosticValueVisible, false)
  assert.equal(guessed.reliable, false)
  assert.equal(guessed.failureClass, 'diagnostic_not_visible')
  const tampered = { ...manifest, episodes: manifest.episodes.slice(1) }
  await assert.rejects(verifyDiagnosticManifest(tampered), /digest|schedule/)
})
