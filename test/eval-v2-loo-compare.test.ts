import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { compareV2LooBatches, looExpectedSourcePaths, parseLooCompareArguments } from '../scripts/eval-v2-compare.js'
import type { V2BatchEvidence } from '../scripts/eval-v2-compare.js'
import type { V2OfflineProbeEvidence } from '../scripts/eval-v2-compare.js'
import { freezeV2, reportV2 } from '../scripts/eval-v2-report.js'
import type { V2Manifest, V2Observation } from '../scripts/eval-v2-report.js'
import type { ComponentLooVariant } from '../scripts/eval-v2-plan.js'

const sha = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')
const stable = (value: unknown): string => JSON.stringify(value)
const resign = (manifest: V2Manifest): V2Manifest => {
  const { digest, ...fields } = manifest
  return { ...fields, digest: sha(stable(fields)) }
}
const priceSnapshot = { source: 'https://api-docs.deepseek.com/quick_start/pricing/', capturedAt: '2026-10-26T00:00:00Z', currency: 'USD', inputPerMillion: 0.3, outputPerMillion: 1.2, cacheReadPerMillion: 0.006 }
const looConfig = {
  split: 'component-loo' as const, tier: '1m' as const, window: 1_000_000,
  model: 'deepseek/deepseek-flash', echoedModel: 'deepseek-flash', modelVersion: 'DeepSeek-V4.1-Flash-1017',
  thinking: 'enabled' as const, sampling: 'provider-default' as const, baseUrl: 'https://api.deepseek.com',
  priceSnapshot, sourceBaseCommit: 'b'.repeat(40), gitCommit: 'a'.repeat(40), variant: 'full' as const,
}
const base = await freezeV2(looConfig)
const benchmarkSha = base.sourceFiles.find(file => file.path === 'scripts/benchmark-components.mjs')!.sha256
const packageJson = { name: '@beforelanding/mini-dsh', version: '0.1.0', scripts: { test: 'x' } }
const packageSha256 = sha(stable(packageJson))
const sourceBase: Record<ComponentLooVariant, string> = {
  full: 'b'.repeat(40), 'no-preview': '1'.repeat(40), 'no-projection': '2'.repeat(40), 'no-report': '3'.repeat(40),
}
const gitCommit: Record<ComponentLooVariant, string> = {
  full: 'a'.repeat(40), 'no-preview': '4'.repeat(40), 'no-projection': '5'.repeat(40), 'no-report': '6'.repeat(40),
}
const variantManifest = (label: ComponentLooVariant): V2Manifest => {
  const clone = JSON.parse(JSON.stringify(base)) as V2Manifest
  clone.variant = label
  clone.sourceBaseCommit = sourceBase[label]
  clone.gitCommit = gitCommit[label]
  for (const file of clone.sourceFiles) {
    if (looExpectedSourcePaths[label].includes(file.path)) file.sha256 = sha(`${label}/${file.path}`)
  }
  for (const path of looExpectedSourcePaths[label]) {
    if (!clone.sourceFiles.some(file => file.path === path)) throw new Error(`test fixture source file missing: ${path}`)
  }
  return resign(clone)
}
const manifests = Object.fromEntries((['full', 'no-preview', 'no-projection', 'no-report'] as const).map(label => [label, variantManifest(label)])) as Record<ComponentLooVariant, V2Manifest>

const metricRow = (options: { input?: number; output?: number; active?: number; request?: number; summary?: number } = {}) => ({
  mainRequests: 1, summaryRequests: options.summary ?? 0, toolCalls: 1, toolErrors: 0, policyRejected: null, toolSkipped: 0,
  inputTokens: options.input ?? 90, outputTokens: options.output ?? 10, summaryTokens: 0, cacheReadTokens: 0, providerTokens: (options.input ?? 90) + (options.output ?? 10),
  estimatedTokens: 0, activeDurationMs: options.active ?? 1000, requestDurationsMs: [options.request ?? 100], summaryDurationMs: 0, timeouts: 0,
  pressureCompactions: 0, prunedTaskIds: [], previewTruncations: 0, stablePromptRuns: 0, multiRoundRuns: 0,
})
const observation = (manifest: V2Manifest, episode: V2Manifest['episodes'][number], options: { success?: boolean; input?: number; output?: number; active?: number } = {}): V2Observation => ({
  taskId: episode.taskId, repeat: episode.repeat, arm: episode.arm,
  status: options.success === false ? 'model_limit' : 'completed', accepted: options.success !== false,
  acceptanceGroups: manifest.tasks.find(task => task.id === episode.taskId)!.groups.map(name => ({ name, passed: options.success !== false })),
  protectedFilesChanged: [], evidenceComplete: true, metrics: metricRow(options),
})
const rows = (manifest: V2Manifest, transform: (episode: V2Manifest['episodes'][number], index: number) => { success?: boolean; input?: number; output?: number; active?: number } = () => ({})) =>
  manifest.episodes.map((episode, index) => observation(manifest, episode, transform(episode, index)))
const evidence = (label: ComponentLooVariant, observations: V2Observation[], startHour: number, stopped = false): V2BatchEvidence => {
  const manifest = manifests[label]
  const startedAt = `2026-10-26T${String(startHour).padStart(2, '0')}:00:00Z`
  const finishedAt = `2026-10-26T${String(startHour).padStart(2, '0')}:30:00Z`
  return {
    evidenceRoot: `memory:${label}`, manifest, observations, packageJson, packageSha256,
    report: { ...reportV2(manifest, observations), startedAt, finishedAt, sourceBaseCommit: manifest.sourceBaseCommit,
      evaluationCommit: manifest.gitCommit, environment: { node: 'v22.22.1', platform: 'win32', release: 'test', isolation: 'wsl-bwrap' },
      spentUsdEstimate: 1, stopped, stopReason: '' },
  }
}
const probe = (label: ComponentLooVariant, options: { passed?: number; propertyReads?: number; snapshotOpens?: number; outputHash?: string } = {}): V2OfflineProbeEvidence => ({
  file: `memory:${label}`, sha256: sha(label), protocol: 'mini-dsh-components-v1', evidenceKind: 'offline-mechanism',
  sourceCommit: sourceBase[label], suiteSha256: benchmarkSha, providerRequests: 0, moduleSha256: {},
  tools: Array.from({ length: 4 }, (_, index) => ({ id: `tool-${index}`, limit: 64, originalBytes: 100, visibleBytes: 64,
    withinLimit: index < (options.passed ?? 4), tailVisible: index < (options.passed ?? 4), fullRecall: true })),
  compaction: [0, 1, 2].map(index => ({ id: `history-${index}`, events: 100, propertyReads: options.propertyReads ?? 10,
    outputSha256: options.outputHash ?? '1'.repeat(64), correct: true, medianMs: 1 })),
  reports: [0, 1, 2].map(index => ({ id: `report-${index}`, checks: 1, uniqueFiles: 2, snapshotOpens: options.snapshotOpens ?? 5,
    outputSha256: options.outputHash ?? '2'.repeat(64), correct: true })),
})
const allRows = (manifest: V2Manifest, transform?: (episode: V2Manifest['episodes'][number], index: number) => { success?: boolean; input?: number; output?: number; active?: number }) => rows(manifest, transform)

function batches(transform: Partial<Record<ComponentLooVariant, (episode: V2Manifest['episodes'][number], index: number) => { success?: boolean; input?: number; output?: number; active?: number }>> = {}) {
  return {
    full: evidence('full', allRows(manifests.full, transform.full), 0),
    'no-preview': evidence('no-preview', allRows(manifests['no-preview'], transform['no-preview']), 1),
    'no-projection': evidence('no-projection', allRows(manifests['no-projection'], transform['no-projection']), 2),
    'no-report': evidence('no-report', allRows(manifests['no-report'], transform['no-report']), 3),
  }
}

function probes(options: Partial<Record<ComponentLooVariant, Parameters<typeof probe>[1]>> = {}) {
  return {
    reference: probe('full', options.full),
    variants: {
      'no-preview': probe('no-preview', { passed: 2, ...options['no-preview'] }),
      'no-projection': probe('no-projection', { propertyReads: 30, ...options['no-projection'] }),
      'no-report': probe('no-report', { snapshotOpens: 20, ...options['no-report'] }),
    },
  }
}

test('LOO comparator pairs each no-X arm with full and reports descriptive attribution', () => {
  const all = batches({
    'no-preview': () => ({ output: 12, active: 1100 }),
    'no-projection': () => ({ active: 1100 }),
    'no-report': () => ({ active: 1100 }),
  })
  const comparison = compareV2LooBatches(all.full, {
    'no-preview': all['no-preview'], 'no-projection': all['no-projection'], 'no-report': all['no-report'],
  }, { probes: probes(), expectedSourceBaseCommits: sourceBase })
  assert.equal(comparison.protocol, 'NX-51-component-loo-v1')
  assert.equal(comparison.significanceClaim, false)
  assert.equal(comparison.reference.metrics.reliableSuccesses, 12)
  for (const label of ['no-preview', 'no-projection', 'no-report'] as const) {
    const result = comparison.variants[label]
    assert.equal(result.quality.reliableCompletion.fullMinusVariant, 0)
    assert.equal(result.tasks.length, 6)
    assert.equal(result.tasks[0]!.reference.length, 2)
    assert.deepEqual(result.source.changed, [...looExpectedSourcePaths[label]].sort())
    assert.equal(result.offline.status, 'confirmed-adverse')
    assert.equal(result.attribution.status, 'signal')
    assert.equal(result.reviewRequired, false)
  }
  assert.equal(comparison.variants['no-preview'].resources.outputTokens.worseWhenRemoved, true)
  assert.equal(comparison.variants['no-projection'].resources.nonModelActiveDurationMs.worseWhenRemoved, true)
})

test('LOO attribution stays inconclusive below 5%, on conflicting repeats, or without offline confirmation', () => {
  const below = batches({ 'no-preview': () => ({ output: 10, active: 1020 }) })
  const belowResult = compareV2LooBatches(below.full, { 'no-preview': below['no-preview'], 'no-projection': below['no-projection'], 'no-report': below['no-report'] }, { probes: probes() })
  assert.equal(belowResult.variants['no-preview'].attribution.status, 'inconclusive')
  assert.ok(belowResult.variants['no-preview'].attribution.reasons.includes('resource-change-below-threshold'))

  const repeat = batches({ 'no-preview': (episode) => episode.repeat === 0 ? { output: 13 } : { output: 9 } })
  const repeatResult = compareV2LooBatches(repeat.full, { 'no-preview': repeat['no-preview'], 'no-projection': repeat['no-projection'], 'no-report': repeat['no-report'] }, { probes: probes() })
  assert.equal(repeatResult.variants['no-preview'].attribution.status, 'inconclusive')
  assert.ok(repeatResult.variants['no-preview'].attribution.reasons.includes('repeat-directions-conflict'))

  const unconfirmed = batches({ 'no-preview': () => ({ output: 12 }) })
  const unconfirmedResult = compareV2LooBatches(unconfirmed.full, { 'no-preview': unconfirmed['no-preview'], 'no-projection': unconfirmed['no-projection'], 'no-report': unconfirmed['no-report'] },
    { probes: probes({ 'no-preview': { passed: 4 } }) })
  assert.equal(unconfirmedResult.variants['no-preview'].attribution.status, 'inconclusive')
  assert.ok(unconfirmedResult.variants['no-preview'].attribution.reasons.includes('mechanism-not-confirmed'))
})

test('LOO attribution marks a cheaper but less reliable arm as an efficiency tradeoff and reviews larger losses', () => {
  const cheaper = batches({ 'no-preview': (_, index) => ({ output: 8, success: index !== 0 }) })
  const tradeoff = compareV2LooBatches(cheaper.full, { 'no-preview': cheaper['no-preview'], 'no-projection': cheaper['no-projection'], 'no-report': cheaper['no-report'] })
  assert.equal(tradeoff.variants['no-preview'].attribution.status, 'efficiency-tradeoff')
  assert.equal(tradeoff.variants['no-preview'].reviewRequired, false)

  const worse = batches({ 'no-preview': (_, index) => ({ output: 12, success: index > 1 }) })
  const review = compareV2LooBatches(worse.full, { 'no-preview': worse['no-preview'], 'no-projection': worse['no-projection'], 'no-report': worse['no-report'] })
  assert.equal(review.variants['no-preview'].reviewRequired, true)
  assert.equal(review.variants['no-preview'].attribution.status, 'inconclusive')
})

test('LOO comparator rejects inexact source paths and incomplete batches', () => {
  const all = batches()
  const missing = variantManifest('no-preview')
  missing.sourceFiles = missing.sourceFiles.map(file => file.path === 'src/plugins/tool-results.ts' ? { ...file, sha256: base.sourceFiles.find(candidate => candidate.path === file.path)!.sha256 } : file)
  assert.throws(() => compareV2LooBatches(all.full, { ...{ 'no-preview': all['no-preview'], 'no-projection': all['no-projection'], 'no-report': all['no-report'] }, 'no-preview': { ...all['no-preview'], manifest: resign(missing) } }), /source paths/)
  const extra = variantManifest('no-projection')
  extra.sourceFiles = extra.sourceFiles.map(file => file.path === 'src/core/budget.ts' ? { ...file, sha256: '9'.repeat(64) } : file)
  assert.throws(() => compareV2LooBatches(all.full, { 'no-preview': all['no-preview'], 'no-projection': { ...all['no-projection'], manifest: resign(extra) }, 'no-report': all['no-report'] }), /source paths/)
  const short = evidence('no-preview', rows(manifests['no-preview']).slice(0, -1), 1)
  assert.throws(() => compareV2LooBatches(all.full, { 'no-preview': short, 'no-projection': all['no-projection'], 'no-report': all['no-report'] }), /incomplete|12-episode/)
})

test('LOO comparator rejects batch order, environment and probe provenance mismatches', () => {
  const all = batches()
  const late = evidence('no-preview', rows(manifests['no-preview']), 0)
  late.report.startedAt = '2026-10-26T00:10:00Z'
  late.report.finishedAt = '2026-10-26T00:20:00Z'
  assert.throws(() => compareV2LooBatches(all.full, { 'no-preview': late, 'no-projection': all['no-projection'], 'no-report': all['no-report'] }), /did not finish|overlap/)
  const environment = evidence('no-preview', rows(manifests['no-preview']), 1)
  environment.report.environment = { ...environment.report.environment, node: 'v24.0.0' }
  assert.throws(() => compareV2LooBatches(all.full, { 'no-preview': environment, 'no-projection': all['no-projection'], 'no-report': all['no-report'] }), /environment/)
  const wrongSource = probe('no-preview', { passed: 2 })
  wrongSource.sourceCommit = '0'.repeat(40)
  assert.throws(() => compareV2LooBatches(all.full, { 'no-preview': all['no-preview'], 'no-projection': all['no-projection'], 'no-report': all['no-report'] },
    { probes: { reference: probe('full'), variants: { 'no-preview': wrongSource, 'no-projection': probe('no-projection', { propertyReads: 30 }), 'no-report': probe('no-report', { snapshotOpens: 20 }) } } }), /source commit/)
})

test('LOO comparator rejects wrong reference, duplicate provenance and probe evidence drift', () => {
  const all = batches()
  const wrongReference = { ...all.full, manifest: resign({ ...all.full.manifest, variant: 'no-preview' }) }
  assert.throws(() => compareV2LooBatches(wrongReference, { 'no-preview': all['no-preview'], 'no-projection': all['no-projection'], 'no-report': all['no-report'] }), /reference protocol/)
  const duplicate = { ...all['no-preview'], manifest: resign({ ...all['no-preview'].manifest, sourceBaseCommit: all.full.manifest.sourceBaseCommit }) }
  assert.throws(() => compareV2LooBatches(all.full, { 'no-preview': duplicate, 'no-projection': all['no-projection'], 'no-report': all['no-report'] }), /duplicate source base/)
  const model = { ...all['no-report'], manifest: resign({ ...all['no-report'].manifest, model: 'deepseek/other' }) }
  assert.throws(() => compareV2LooBatches(all.full, { 'no-preview': all['no-preview'], 'no-projection': all['no-projection'], 'no-report': model }), /model/)
  const packageDrift = { ...all['no-report'], packageJson: { ...packageJson, version: '9.9.9' } }
  assert.throws(() => compareV2LooBatches(all.full, { 'no-preview': all['no-preview'], 'no-projection': all['no-projection'], 'no-report': packageDrift }), /package\.json/)
  const suite = probe('no-preview', { passed: 2 })
  suite.suiteSha256 = '0'.repeat(64)
  assert.throws(() => compareV2LooBatches(all.full, { 'no-preview': all['no-preview'], 'no-projection': all['no-projection'], 'no-report': all['no-report'] },
    { probes: { reference: probe('full'), variants: { 'no-preview': suite, 'no-projection': probe('no-projection', { propertyReads: 30 }), 'no-report': probe('no-report', { snapshotOpens: 20 }) } } }), /suite hash/)
  const changed = probe('no-projection', { propertyReads: 30, outputHash: '9'.repeat(64) })
  assert.throws(() => compareV2LooBatches(all.full, { 'no-preview': all['no-preview'], 'no-projection': all['no-projection'], 'no-report': all['no-report'] },
    { probes: { reference: probe('full'), variants: { 'no-preview': probe('no-preview', { passed: 2 }), 'no-projection': changed, 'no-report': probe('no-report', { snapshotOpens: 20 }) } } }), /compaction output/)
  assert.throws(() => compareV2LooBatches(all.full, { 'no-preview': all['no-preview'], 'no-projection': all['no-projection'], 'no-report': all['no-report'] },
    { probes: { reference: probe('full'), variants: { 'no-preview': probe('no-preview', { passed: 2 }), 'no-projection': probe('no-projection', { propertyReads: 30 }) } } as never }), /offline probe missing/)
})

test('LOO CLI parser requires three labelled variants and all-or-none probes', () => {
  const args = ['--reference-evidence-root', 'full', '--variant', 'no-preview=np', '--variant', 'no-projection=nj', '--variant', 'no-report=nr', '--output', 'out.json']
  const parsed = parseLooCompareArguments(args)
  assert.equal(parsed.variants['no-preview'].endsWith('np'), true)
  assert.throws(() => parseLooCompareArguments(args.filter((_, index) => index !== 2 && index !== 3)), /missing --variant no-preview/)
  assert.throws(() => parseLooCompareArguments([...args, '--variant', 'no-preview=again']), /duplicate variant/)
  assert.throws(() => parseLooCompareArguments([...args, '--reference-probe', 'full.json']), /missing --variant-probe/)
  assert.throws(() => parseLooCompareArguments([...args, '--variant-probe', 'full=full.json']), /only valid for a no-X variant/)
  assert.throws(() => parseLooCompareArguments([...args, '--expect-source-base', 'full=abc']), /40-hex/)
  const complete = parseLooCompareArguments([...args, '--reference-probe', 'full.json', '--variant-probe', 'no-preview=np.json', '--variant-probe', 'no-projection=nj.json', '--variant-probe', 'no-report=nr.json'])
  assert.equal(complete.referenceProbe?.endsWith('full.json'), true)
})
