import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { estimateBudget, mapHostToContainer, selectInstances, summarizeEpisodes, validatePrediction } from '../scripts/swebench/protocol.js'
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
