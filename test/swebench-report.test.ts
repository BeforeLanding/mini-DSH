import test from 'node:test'
import assert from 'node:assert/strict'
import { buildReport } from '../scripts/swebench/report.js'
import type { SwebenchEpisodeResult, SwebenchScores } from '../scripts/swebench/report.js'
import type { SwebenchRunManifest } from '../scripts/swebench/protocol.js'

const ids = ['i1', 'i2', 'i3', 'i4']
const manifest = {
  dataset: { name: 'd', revision: 'r' }, harnessCommit: 'c', freezeStatus: 'frozen',
  formal: { arms: ['x'], schedule: ids.map(instanceId => ({ instanceId, armId: 'x' })) },
  development: { arms: [], schedule: [] },
} as unknown as SwebenchRunManifest
const run = (instanceId: string, status = 'completed', resolved = false) => ({ instanceId, armId: 'x', status, resolved, emptyPatch: false, patchPath: 'p' }) as unknown as SwebenchEpisodeResult
const batch = { startedAt: 's', finishedAt: 'f' }
const scoreOf = (instanceId: string, classification: string) => ({ armId: 'x', instanceId, resolved: classification === 'resolved', classification, scoreRunId: 's' })

test('report keeps the legacy per-arm fields and values and adds a trials block', () => {
  const scores = { runIds: {}, results: [scoreOf('i1', 'resolved'), scoreOf('i2', 'unresolved'), scoreOf('i3', 'error')] } as unknown as SwebenchScores
  // i4 is planned but not executed
  const report = buildReport(manifest, 'formal', [run('i1', 'completed', true), run('i2'), run('i3')], scores, batch)
  const arm = report.perArm[0]!
  assert.equal(arm.planned, 4)
  assert.equal(arm.executed, 3)
  assert.equal(arm.total, 3)
  assert.equal(arm.resolved, 1)
  assert.equal(arm.resolvedRate, 1 / 3)
  assert.equal(arm.resolvedOverPlanned, 1)
  assert.equal(arm.resolvedRateOverPlanned, 0.25)
  assert.match(arm.note, /executed/)
  assert.match(arm.note, /planned/)
  const trials = arm.trials!
  assert.equal(trials.delivery.denominator, 4)
  assert.equal(trials.delivery.passed, 1)
  // the scoring error is unknown/grader_error, not a failed task
  assert.equal(trials.failed, 1)
  assert.equal(trials.gradable.denominator, 2)
  assert.equal(trials.coverage.grader_error, 1)
  assert.equal(trials.coverage.notExecuted, 1)
})

test('report generation rejects duplicate or out-of-plan episode records', () => {
  const scores = { runIds: {}, results: [] } as unknown as SwebenchScores
  assert.throws(() => buildReport(manifest, 'formal', [run('i1'), run('i1')], scores, batch), /duplicate record/)
  assert.throws(() => buildReport(manifest, 'formal', [run('zz')], scores, batch), /outside the planned trials/)
})
