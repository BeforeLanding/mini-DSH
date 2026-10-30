import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import {
  assertSanitizedInstances, buildSchedule, estimateBudget, mapHostToContainer, mcnemarExact, pairedFourCell,
  sanitizeInstanceRow, selectInstances, summarizeEpisodes, tokenCapFromUsd, usageCost, validatePrediction, validateRunManifest,
  wilsonInterval,
} from '../scripts/swebench/protocol.js'
import type { SwebenchInstance } from '../scripts/swebench/protocol.js'

const dataset: SwebenchInstance[] = [
  { instance_id: 'alpha__one-1', repo: 'alpha/one', base_commit: 'a1' },
  { instance_id: 'alpha__one-2', repo: 'alpha/one', base_commit: 'a2' },
  { instance_id: 'alpha__one-3', repo: 'alpha/one', base_commit: 'a3' },
  { instance_id: 'beta__two-1', repo: 'beta/two', base_commit: 'b1' },
  { instance_id: 'beta__two-2', repo: 'beta/two', base_commit: 'b2' },
  { instance_id: 'gamma__three-1', repo: 'gamma/three', base_commit: 'g1' },
]

test('selection is seeded, repository-stratified, and excludes before sampling', () => {
  const first = selectInstances(dataset, { tasks: 5, seed: 42, exclude: ['alpha__one-2'] })
  const second = selectInstances(dataset, { tasks: 5, seed: 42, exclude: ['alpha__one-2'] })
  assert.deepEqual(first.map(item => item.instance_id), second.map(item => item.instance_id))
  assert.equal(first.length, 5)
  assert.ok(!first.some(item => item.instance_id === 'alpha__one-2'))
  assert.equal(new Set(first.map(item => item.repo)).size, 3)
  assert.notDeepEqual(first.map(item => item.instance_id), selectInstances(dataset, { tasks: 5, seed: 7, exclude: ['alpha__one-2'] }).map(item => item.instance_id))
  assert.throws(() => selectInstances(dataset, { tasks: 7, seed: 1 }), /only 6 eligible/)
  assert.throws(() => selectInstances([...dataset, dataset[0]!], { tasks: 1, seed: 1 }), /duplicate instance_id/)
})

test('budget reports a configuration ceiling rather than a promised spend', () => {
  const budget = estimateBudget({ formalTasks: 50, arms: 2, perTaskCapUsd: 0.5, devTasks: 5, devRunsPerTask: 1, devPerTaskCapUsd: 0.5, computeReserveUsd: 7 })
  assert.equal(budget.formalCeilingUsd, 50)
  assert.equal(budget.developmentCeilingUsd, 2.5)
  assert.equal(budget.totalCeilingUsd, 59.5)
  assert.match(budget.note, /not an expected spend/)
  assert.throws(() => estimateBudget({ formalTasks: 0, arms: 2, perTaskCapUsd: 1, devTasks: 0, devRunsPerTask: 0, devPerTaskCapUsd: 0, computeReserveUsd: 0 }), /positive safe integer/)
})

test('predictions allow an empty patch but require the official fields', () => {
  assert.deepEqual(validatePrediction({ instance_id: 'a', model_name_or_path: 'm', model_patch: '' }), { instance_id: 'a', model_name_or_path: 'm', model_patch: '' })
  assert.throws(() => validatePrediction({ instance_id: 'a', model_name_or_path: 'm' }), /model_patch/)
  assert.throws(() => validatePrediction({ instance_id: '', model_name_or_path: 'm', model_patch: '' }), /instance_id/)
})

test('host candidate paths map explicitly into the container and cannot escape', () => {
  const root = path.resolve('candidate')
  assert.equal(mapHostToContainer(root, path.join(root, 'src', 'a.ts')), '/testbed/src/a.ts')
  assert.equal(mapHostToContainer(root, root), '/testbed')
  assert.throws(() => mapHostToContainer(root, path.dirname(root)), /escapes/)
})

test('episode summaries keep infrastructure failures in the denominator and unknown cost separate', () => {
  const summary = summarizeEpisodes([
    { instanceId: 'a', resolved: true, status: 'completed', costUsd: 0.2 },
    { instanceId: 'b', resolved: false, status: 'completed', costUsd: 0.3 },
    { instanceId: 'c', resolved: false, status: 'infrastructure', usageUnknown: true },
    { instanceId: 'd', resolved: false, status: 'timeout' },
  ])
  assert.equal(summary.total, 4)
  assert.equal(summary.resolved, 1)
  assert.equal(summary.resolvedRate, 0.25)
  assert.equal(summary.infrastructure, 1)
  assert.equal(summary.timeouts, 1)
  assert.equal(summary.knownCostUsd, 0.5)
  assert.equal(summary.unknownCostEpisodes, 2)
  assert.match(summary.denominator, /all planned episodes/)
})

test('raw dataset rows are sanitized and gold fields cannot reach the runner', () => {
  const clean = sanitizeInstanceRow({ instance_id: 'alpha__one-1', repo: 'alpha/one', base_commit: 'a1', problem_statement: 'Fix it', patch: 'gold', test_patch: 'hidden' })
  assert.deepEqual(clean, { instance_id: 'alpha__one-1', repo: 'alpha/one', base_commit: 'a1', problem_statement: 'Fix it' })
  assert.throws(() => assertSanitizedInstances([{ ...clean, patch: 'gold' }]), /gold\/hidden field patch/)
  assert.throws(() => assertSanitizedInstances([{ ...clean, test_patch: 'hidden' }]), /gold\/hidden field test_patch/)
})

test('schedule is deterministic, interleaves arms, and covers each pair exactly once', () => {
  const instances = dataset.slice(0, 3)
  const first = buildSchedule(instances, ['a', 'b', 'c'], 7)
  assert.deepEqual(first, buildSchedule(instances, ['a', 'b', 'c'], 7))
  assert.equal(first.length, 9)
  assert.equal(new Set(first.map(episode => `${episode.instanceId}/${episode.armId}`)).size, 9)
  for (const instance of instances) assert.deepEqual(first.filter(episode => episode.instanceId === instance.instance_id).map(episode => episode.armId).sort(), ['a', 'b', 'c'])
  assert.notDeepEqual(first.map(episode => episode.armId), buildSchedule(instances, ['a', 'b', 'c'], 8).map(episode => episode.armId))
})

test('Wilson intervals, exact McNemar, and paired four-cell counts are reproducible', () => {
  const interval = wilsonInterval(5, 10)
  assert.ok(Math.abs(interval.low - 0.236593) < 1e-5)
  assert.ok(Math.abs(interval.high - 0.763407) < 1e-5)
  assert.deepEqual(wilsonInterval(0, 0), { low: 0, high: 1 })
  assert.ok(Math.abs(mcnemarExact(1, 9) - 0.021484375) < 1e-9)
  assert.equal(mcnemarExact(0, 0), 1)
  const a = new Map([['x', true], ['y', true], ['z', false]])
  const b = new Map([['x', true], ['y', false], ['z', false]])
  const paired = pairedFourCell(a, b)
  assert.equal(paired.bothResolved, 1)
  assert.equal(paired.onlyA, 1)
  assert.equal(paired.onlyB, 0)
  assert.equal(paired.neither, 1)
  assert.equal(paired.mcnemarExactP, 1)
  assert.throws(() => pairedFourCell(a, new Map([['x', true]])), /same instances/)
})

test('cost uses provider usage only and the derived token cap is conservative', () => {
  const prices = { currency: 'USD' as const, inputUsdPerMillion: 1, cachedInputUsdPerMillion: 0.5, outputUsdPerMillion: 2, capturedAt: '2026-10-20', source: 'test' }
  const known = usageCost([{ inputTokens: 1_000, outputTokens: 500, totalTokens: 1_500, source: 'provider', uncertain: false, cacheReadTokens: 200 }], prices)
  assert.equal(known.unknown, false)
  assert.equal(known.costUsd, 0.0019)
  assert.equal(usageCost([{ inputTokens: 10, outputTokens: 5, totalTokens: 15, source: 'estimated', uncertain: true }], prices).unknown, true)
  assert.equal(usageCost([], prices).unknown, true)
  assert.equal(tokenCapFromUsd(1, prices), 500_000)
})

test('run manifest validation rejects draft-incompatible schemas and inconsistent schedules', () => {
  const instance = { instance_id: 'alpha__one-1', repo: 'alpha/one', base_commit: 'a1', problem_statement: 'Fix it' }
  const command = ['{python}', '-m', 'minisweagent.run.benchmarks.swebench', '--subset', '{dataset}', '--split', 'test',
    '--output', '{output}', '--workers', '1', '-c', '{upstream_config}', '-c', '{config}']
  const arms = [
    { id: 'candidate', system: 'mini-dsh', role: 'c', model: { provider: 'p', name: 'm', contextWindowTokens: 1_000_000 }, budget: { inputTargetTokens: 65_536 } },
    { id: 'baseline', system: 'external', role: 'b', model: { provider: 'p', name: 'm', contextWindowTokens: 1_000_000 }, external: {
      commit: 'a83fcae82d2a08f0ee0c688f9d137b3566c097f8', command, contractVersion: 1, version: '2.4.6', modelName: 'p/m',
      upstreamConfigSha256: 'a'.repeat(64), installSha256: 'b'.repeat(64), environmentParity: 'candidate-isolation-v1', apiKeyEnv: 'DEEPSEEK_API_KEY',
    }, budget: {} },
  ]
  const batch = { tasks: 1, seed: 1, exclusions: [], instances: [instance], arms: ['candidate', 'baseline'], schedule: buildSchedule([instance], ['candidate', 'baseline'], 1) }
  const manifest = {
    schemaVersion: 3, kind: 'swebench-run-manifest', freezeStatus: 'frozen', dataset: { name: 'Verified', revision: 'r1' }, harnessCommit: 'abc1234',
    selection: {}, development: batch, formal: batch, arms, promptTemplate: 'Issue: {problem_statement}',
    caps: { perTask: { maxCostUsd: 1, maxModelRequests: 10, maxToolCalls: 10, wallClockMs: 1000, maxOutputTokens: 100 },
      developmentPerTask: { maxCostUsd: 1, maxModelRequests: 10, maxToolCalls: 10, wallClockMs: 1000, maxOutputTokens: 100 },
      batch: { maxCostUsd: 10, maxEpisodes: 10 } },
    prices: null, scoring: {}, environment: { imageDigests: null }, authorization: 'none', missing: [], createdAt: '2026-10-20', paidRequests: 0,
  }
  assert.equal(validateRunManifest(manifest).freezeStatus, 'frozen')
  assert.deepEqual(validateRunManifest(manifest).environment, { imageDigests: null })
  assert.equal(validateRunManifest({ ...manifest, environment: { imageDigests: null, commandEnvironment: 'testbed-v1' } }).environment.commandEnvironment, 'testbed-v1')
  assert.throws(() => validateRunManifest({ ...manifest, environment: { imageDigests: null, commandEnvironment: 'base' } }), /commandEnvironment/)
  assert.throws(() => validateRunManifest({ ...manifest, schemaVersion: 1 }), /unsupported/)
  assert.throws(() => validateRunManifest({ ...manifest, formal: { ...batch, schedule: batch.schedule.slice(0, 1) } }), /cover every instance and arm/)
  assert.throws(() => validateRunManifest({ ...manifest, promptTemplate: 'no placeholder' }), /problem_statement/)
})
