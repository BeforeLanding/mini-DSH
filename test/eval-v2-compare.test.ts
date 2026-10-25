import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { compareV2Batches } from '../scripts/eval-v2-compare.js'
import type { V2BatchEvidence } from '../scripts/eval-v2-compare.js'
import { freezeV2, reportV2 } from '../scripts/eval-v2-report.js'
import type { V2Manifest, V2Observation } from '../scripts/eval-v2-report.js'

const sha = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')
const stable = (value: unknown): string => JSON.stringify(value)
const resign = (manifest: V2Manifest): V2Manifest => {
  const { digest, ...fields } = manifest
  return { ...fields, digest: sha(stable(fields)) }
}
const componentConfig = {
  split: 'component' as const, tier: '1m' as const, window: 1_000_000,
  model: 'deepseek/deepseek-flash', echoedModel: 'deepseek-flash', modelVersion: 'DeepSeek-V4.1-Flash-1017',
  thinking: 'enabled' as const, sampling: 'provider-default' as const, baseUrl: 'https://api.deepseek.com',
  priceSnapshot: { source: 'https://api-docs.deepseek.com/quick_start/pricing/', capturedAt: '2026-10-25T00:00:00Z', currency: 'USD', inputPerMillion: 0.3, outputPerMillion: 1.2, cacheReadPerMillion: 0.006 },
  sourceBaseCommit: 'b'.repeat(40), gitCommit: 'a'.repeat(40),
}
const metrics = (tokens: number) => ({
  mainRequests: 1, summaryRequests: 0, toolCalls: 1, toolErrors: 0, policyRejected: null, toolSkipped: 0,
  inputTokens: tokens - 10, outputTokens: 10, summaryTokens: 0, cacheReadTokens: 0, providerTokens: tokens, estimatedTokens: 0,
  activeDurationMs: 1000, requestDurationsMs: [100], summaryDurationMs: 0, timeouts: 0,
  pressureCompactions: 0, prunedTaskIds: [], previewTruncations: 0, stablePromptRuns: 0, multiRoundRuns: 0,
})
const row = (manifest: V2Manifest, episode: V2Manifest['episodes'][number], success: boolean, tokens = 100): V2Observation => ({
  taskId: episode.taskId, repeat: episode.repeat, arm: episode.arm,
  status: success ? 'completed' : 'model_limit', accepted: success,
  acceptanceGroups: manifest.tasks.find(task => task.id === episode.taskId)!.groups.map(name => ({ name, passed: success })),
  protectedFilesChanged: [], evidenceComplete: true, metrics: metrics(tokens),
})
const evidence = (manifest: V2Manifest, observations: V2Observation[], packageJson: Record<string, unknown>, startedAt: string, finishedAt: string, stopped = false): V2BatchEvidence => ({
  evidenceRoot: `memory:${manifest.sourceBaseCommit}`,
  manifest, observations, packageJson, packageSha256: 'f'.repeat(64),
  report: { ...reportV2(manifest, observations), startedAt, finishedAt, sourceBaseCommit: manifest.sourceBaseCommit,
    evaluationCommit: manifest.gitCommit, environment: { node: 'v22.22.1', platform: 'win32', release: 'test', isolation: 'wsl-bwrap' },
    spentUsdEstimate: 1, stopped, stopReason: '' },
})
const packageBase = { name: '@beforelanding/mini-dsh', version: '0.1.0', scripts: { test: 'x' } }
const packageNew = { ...packageBase, scripts: { ...packageBase.scripts, 'bench:components': 'y' } }
const oldManifest = async (base: V2Manifest): Promise<V2Manifest> => {
  const clone = JSON.parse(JSON.stringify(base)) as V2Manifest
  clone.gitCommit = 'd'.repeat(40)
  clone.sourceBaseCommit = 'c'.repeat(40)
  clone.sourceFiles = clone.sourceFiles.map(file => file.path === 'src/core/agent-loop-runtime.ts' ? { ...file, sha256: '0'.repeat(64) }
    : file.path === 'package.json' ? { ...file, sha256: 'e'.repeat(64) } : file)
  return resign(clone)
}

test('component comparator applies the preregistered quality and resource tolerances', async () => {
  const newManifest = await freezeV2(componentConfig)
  const old = await oldManifest(newManifest)
  const allOld = newManifest.episodes.map(episode => row(old, episode, true))
  const allNew = newManifest.episodes.map(episode => row(newManifest, episode, true))
  const oldBatch = evidence(old, allOld, packageBase, '2026-10-25T02:00:00Z', '2026-10-25T02:30:00Z')
  const newBatch = evidence(newManifest, allNew, packageNew, '2026-10-25T00:00:00Z', '2026-10-25T00:30:00Z')
  const pass = compareV2Batches(oldBatch, newBatch)
  assert.equal(pass.gate.status, 'pass')
  assert.equal(pass.gate.mergeEligible, true)
  assert.equal(pass.reliableCompletion.old, 12)
  assert.equal(pass.sourceDifferences.allowed.some(file => file.reason === 'product-source'), true)
  assert.equal(pass.sourceDifferences.rejected.length, 0)

  const tolerated = allNew.map((record, index) => index === 0 ? row(newManifest, newManifest.episodes[0]!, false) : record)
  assert.equal(compareV2Batches(oldBatch, evidence(newManifest, tolerated, packageNew, '2026-10-25T00:00:00Z', '2026-10-25T00:30:00Z')).gate.status, 'pass')

  const twoShort = allNew.map((record, index) => index === 0 ? row(newManifest, newManifest.episodes[0]!, false)
    : index === 1 ? row(newManifest, newManifest.episodes[1]!, false) : record)
  const failed = compareV2Batches(oldBatch, evidence(newManifest, twoShort, packageNew, '2026-10-25T00:00:00Z', '2026-10-25T00:30:00Z'))
  assert.equal(failed.gate.status, 'fail')
  assert.equal(failed.gate.mergeEligible, false)

  const oldTighter = old.episodes.map(episode => row(old, episode, true, 100))
  const tokenBoundary = newManifest.episodes.map(episode => row(newManifest, episode, true, 115))
  assert.equal(compareV2Batches(evidence(old, oldTighter, packageBase, '2026-10-25T02:00:00Z', '2026-10-25T02:30:00Z'),
    evidence(newManifest, tokenBoundary, packageNew, '2026-10-25T00:00:00Z', '2026-10-25T00:30:00Z')).tokens.pass, true)
  const over = newManifest.episodes.map(episode => row(newManifest, episode, true, 116))
  assert.equal(compareV2Batches(evidence(old, oldTighter, packageBase, '2026-10-25T02:00:00Z', '2026-10-25T02:30:00Z'),
    evidence(newManifest, over, packageNew, '2026-10-25T00:00:00Z', '2026-10-25T00:30:00Z')).tokens.pass, false)
})

test('component comparator flags a double task regression without failing the aggregate tolerance', async () => {
  const newManifest = await freezeV2(componentConfig)
  const old = await oldManifest(newManifest)
  const taskA = newManifest.tasks[0]!.id, taskB = newManifest.tasks[1]!.id
  const oldRows = newManifest.episodes.map(episode => row(old, episode, episode.taskId === taskB ? episode.repeat === 0 : true))
  const newRows = newManifest.episodes.map(episode => row(newManifest, episode, episode.taskId !== taskA))
  const report = compareV2Batches(evidence(old, oldRows, packageBase, '2026-10-25T02:00:00Z', '2026-10-25T02:30:00Z'),
    evidence(newManifest, newRows, packageNew, '2026-10-25T00:00:00Z', '2026-10-25T00:30:00Z'))
  assert.equal(report.reliableCompletion.old, 11)
  assert.equal(report.reliableCompletion.new, 10)
  assert.equal(report.reliableCompletion.pass, true)
  assert.equal(report.gate.status, 'review-required')
  assert.equal(report.gate.mergeEligible, false)
  assert.deepEqual(report.gate.reasons, ['task-double-regression-needs-trace-review'])
})

test('component comparator rejects incomparable manifests and evidence', async () => {
  const newManifest = await freezeV2(componentConfig)
  const old = await oldManifest(newManifest)
  const rows = newManifest.episodes.map(episode => row(newManifest, episode, true))
  const base = evidence(newManifest, rows, packageNew, '2026-10-25T00:00:00Z', '2026-10-25T00:30:00Z')
  const oldBase = evidence(old, newManifest.episodes.map(episode => row(old, episode, true)), packageBase, '2026-10-25T02:00:00Z', '2026-10-25T02:30:00Z')
  assert.throws(() => compareV2Batches(oldBase, { ...base, manifest: resign({ ...newManifest, model: 'deepseek/other' }) }), /model/)
  assert.throws(() => compareV2Batches(oldBase, { ...base, manifest: resign({ ...newManifest, sourceBaseCommit: old.sourceBaseCommit }) }), /source base/)
  assert.throws(() => compareV2Batches(oldBase, { ...base, manifest: resign({ ...newManifest, toolSchemaSha256: '1'.repeat(64) }) }), /tool schema/)
  assert.throws(() => compareV2Batches(oldBase, { ...base, report: { ...base.report, incomplete: true } }), /incomplete/)
  assert.throws(() => compareV2Batches(oldBase, { ...base, observations: rows.map((row, index) => index === 0 ? { ...row, metrics: { ...row.metrics, estimatedTokens: 1 } } : row) }), /provider usage/)
  assert.throws(() => compareV2Batches(oldBase, { ...base, packageJson: { ...packageNew, version: '9.9.9' } }), /non-script/)
  assert.throws(() => compareV2Batches(oldBase, { ...base, packageJson: { ...packageNew, scripts: { ...packageNew.scripts, test: 'changed' } } }), /script differs/)
  assert.throws(() => compareV2Batches(oldBase, { ...base, manifest: resign({ ...newManifest, sourceFiles: newManifest.sourceFiles.map(file => file.path === 'AGENTS.md' ? { ...file, sha256: '2'.repeat(64) } : file) }) }), /source differences/)
})
