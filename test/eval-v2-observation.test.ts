import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deriveV2Observation } from '../scripts/eval-v2-observation.js'
import type { RunOutcome } from '../scripts/eval-runner.js'
import type { SessionEvent } from '../src/core/contracts.js'

test('V2 observation separates summary requests and skipped tools from executed errors', () => {
  const at = '2026-10-15T00:00:00.000Z'
  const raw = [
    { type: 'model/start', data: { requestId: 'main' }, at },
    { type: 'context/summary-start', data: { trigger: 'pressure' }, at },
    { type: 'model/start', data: { requestId: 'summary' }, at },
    { type: 'model/usage', data: { requestId: 'summary', usage: { totalTokens: 30, source: 'provider' } }, at },
    { type: 'model/end', data: { requestId: 'summary' }, at: '2026-10-15T00:00:00.250Z' },
    { type: 'tool/result', data: { status: 'skipped' }, at },
  ].map((event, seq) => ({ ...event, runId: 'run', taskId: 'stage', seq })) as unknown as SessionEvent[]
  const outcome = {
    status: 'completed', accepted: true,
    counters: { modelRequests: 2, toolCalls: 1, toolErrors: 1, previewTruncations: 1, inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadTokens: 25, activeDurationMs: 1000, approvalDurationMs: 0 },
    acceptance: { passed: true, exitCode: 0, output: '', protectedFilesChanged: [], groups: ['a', 'b', 'c', 'd'].map(name => ({ name, passed: true })) },
    tasks: [{ taskId: 'stage', status: 'completed', counters: {}, projections: 2, firstPrunedProjection: 2, removedTaskIds: ['prior'], unsentProjections: 0,
      usageSources: { provider: 1, estimated: 1 }, compactions: { applied: 1, pressure: 1, declined: 0 }, promptRounds: { rounds: 2, stable: 1 }, requestDurationsMs: [100, 250], modelDurationMs: 350 }],
  } as unknown as RunOutcome
  const row = deriveV2Observation({ taskId: 'U04', repeat: 0, arm: 'full', block: 0 }, outcome, raw, true)
  assert.equal(row.metrics.mainRequests, 1)
  assert.equal(row.metrics.summaryRequests, 1)
  assert.equal(row.metrics.summaryTokens, 30)
  assert.equal(row.metrics.summaryDurationMs, 250)
  assert.equal(row.metrics.toolErrors, 1)
  assert.equal(row.metrics.toolSkipped, 1)
  assert.equal(row.metrics.policyRejected, null)
  assert.equal(row.metrics.pressureCompactions, 1)
  assert.deepEqual(row.metrics.prunedTaskIds, ['prior'])
})
