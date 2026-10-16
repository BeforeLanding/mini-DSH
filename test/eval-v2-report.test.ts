import assert from 'node:assert/strict'
import { test } from 'node:test'
import { freezeV2, reliableSuccess, reportV2, verifyV2FrozenFiles } from '../scripts/eval-v2-report.js'
import type { V2Observation } from '../scripts/eval-v2-report.js'

const config = {
  split: 'formal' as const, tier: '2m' as const, window: 131_072, model: 'deepseek/test-model', echoedModel: 'test-model', thinking: 'enabled' as const, sampling: 'provider-default' as const, baseUrl: 'https://example.invalid',
  priceSnapshot: { source: 'offline-test', capturedAt: '2026-10-15T00:00:00Z', currency: 'USD', inputPerMillion: 1, outputPerMillion: 2, cacheReadPerMillion: 0.1 },
  gitCommit: 'a'.repeat(40),
}
const metrics = () => ({
  mainRequests: 2, summaryRequests: 1, toolCalls: 3, toolErrors: 1, policyRejected: 0, toolSkipped: 1,
  inputTokens: 100, outputTokens: 20, summaryTokens: 5, cacheReadTokens: 30, providerTokens: 80, estimatedTokens: 40,
  activeDurationMs: 1000, requestDurationsMs: [100, 200], summaryDurationMs: 50, timeouts: 0,
  pressureCompactions: 1, prunedTaskIds: ['prior'], previewTruncations: 1, stablePromptRuns: 1, multiRoundRuns: 1,
})
const observation = (taskId: string, repeat: number, arm: V2Observation['arm'], success: boolean): V2Observation => ({
  taskId, repeat, arm, status: success ? 'completed' : 'model_limit', accepted: success,
  acceptanceGroups: ['one', 'two', 'three', 'four'].map(name => ({ name, passed: success })),
  protectedFilesChanged: [], evidenceComplete: true, metrics: metrics(),
})

test('V2 freeze hashes all task contracts and the fixed source/config schedule', async () => {
  const manifest = await freezeV2(config)
  assert.equal(manifest.tasks.length, 20)
  assert.equal(manifest.episodes.length, 240)
  assert.equal(manifest.tasks.every(task => task.files.some(file => file.path === 'verify.mjs') && task.files.some(file => file.path.startsWith('initial/'))), true)
  assert.ok(manifest.sourceFiles.some(file => file.path === 'src/core/agent-loop-runtime.ts'))
  assert.match(manifest.digest, /^[a-f0-9]{64}$/)
  await verifyV2FrozenFiles(manifest)
  await verifyV2FrozenFiles(JSON.parse(JSON.stringify(manifest)))
  await assert.rejects(verifyV2FrozenFiles({ ...manifest, digest: '0'.repeat(64) }), /digest/)
  await assert.rejects(freezeV2({ ...config, priceSnapshot: { ...config.priceSnapshot, inputPerMillion: -1 } }), /price/)
})

test('V2 report keeps the fixed denominator, missing range, six measures and root-paired delta', async () => {
  const manifest = await freezeV2(config)
  const records = manifest.episodes.map(episode => {
    const root = manifest.tasks.findIndex(task => task.id === episode.taskId)
    const row = observation(episode.taskId, episode.repeat, episode.arm, episode.arm === 'full' ? root < 12 : episode.arm === 'baseline' ? root < 8 : root < 10)
    row.acceptanceGroups = manifest.tasks[root]!.groups.map(name => ({ name, passed: row.accepted === true }))
    return row
  })
  const report = reportV2(manifest, records)
  assert.equal(report.incomplete, false)
  assert.equal(report.primary.estimate, 0.2)
  assert.equal(report.arms.find(arm => arm.arm === 'baseline')?.reliableSuccesses, 24)
  assert.equal(report.arms.find(arm => arm.arm === 'full')?.reliableSuccesses, 36)
  assert.equal(report.arms.find(arm => arm.arm === 'full')?.artifactAccepted, 36)
  const budgetedArtifact = records.map(row => row.arm === 'full' && row.taskId === manifest.tasks[12]!.id && row.repeat === 0 ? { ...row, accepted: true } : row)
  const budgetedReport = reportV2(manifest, budgetedArtifact)
  assert.equal(budgetedReport.arms.find(arm => arm.arm === 'full')?.reliableSuccesses, 36)
  assert.equal(budgetedReport.arms.find(arm => arm.arm === 'full')?.artifactAccepted, 37)
  assert.equal(report.arms.find(arm => arm.arm === 'full')?.modelRounds.all.total, 180)
  assert.equal(report.arms.find(arm => arm.arm === 'full')?.tools.errors.total, 60)
  assert.equal(report.arms.find(arm => arm.arm === 'full')?.tokens.tokensPerReliableSuccess, 200)
  assert.equal(report.arms.find(arm => arm.arm === 'full')?.latency.request.count, 120)
  assert.equal(report.pairs.length, 20)
  const incomplete = reportV2(manifest, records.slice(0, -1))
  assert.equal(incomplete.incomplete, true)
  assert.equal(incomplete.missing.length, 1)
  assert.equal(incomplete.primary.estimate, null)
  const full = incomplete.arms.find(arm => arm.arm === 'full')!
  assert.equal(full.rateUpper, (full.reliableSuccesses + full.planned - full.executed) / full.planned)
  assert.throws(() => reportV2(manifest, [...records, records[0]!]), /duplicate/)
  assert.throws(() => reportV2({ ...manifest, model: 'changed' }, records), /integrity/)
  const errored = records.map((row, index) => index === 0 ? { ...row, status: 'error', failureReason: 'infrastructure', providerHttpStatus: 429 } : row)
  const invalid = reportV2(manifest, errored)
  assert.equal(invalid.incomplete, true)
  assert.deepEqual(invalid.invalid, [`${records[0]!.taskId}/${records[0]!.repeat}/${records[0]!.arm}`])
  assert.equal(invalid.primary.complete, false)
  assert.equal(invalid.primary.estimate, null)
  assert.equal(invalid.thresholdClaimSupported, false)
  const invalidArm = invalid.arms.find(arm => arm.arm === records[0]!.arm)!
  assert.equal(invalidArm.rateUpper, (invalidArm.reliableSuccesses + 1) / invalidArm.planned)
})

test('reliable success requires terminal completion, four groups, clean protection and complete evidence', () => {
  const good = observation('U01', 0, 'baseline', true)
  assert.equal(reliableSuccess(good), true)
  assert.equal(reliableSuccess({ ...good, evidenceComplete: false }), false)
  assert.equal(reliableSuccess({ ...good, protectedFilesChanged: ['docs/SPEC.md'] }), false)
  assert.equal(reliableSuccess({ ...good, acceptanceGroups: good.acceptanceGroups.slice(0, 3) }), false)
  assert.equal(reliableSuccess({ ...good, status: 'output_limit' }), false)
})
