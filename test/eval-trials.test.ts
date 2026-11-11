import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { orchestrationPlanned, orchestrationRecords, summarizeTrials, sweTrials } from '../scripts/eval-trials.js'
import type { PlannedTrial, TrialRecord } from '../scripts/eval-trials.js'
import { assembleRunMatrix } from '../scripts/eval-orchestrate.js'
import { wilsonInterval } from '../scripts/swebench/protocol.js'
import type { SwebenchRunManifest } from '../scripts/swebench/protocol.js'
import type { SwebenchEpisodeResult, SwebenchScores } from '../scripts/swebench/report.js'

const plan = (n: number): PlannedTrial[] => Array.from({ length: n }, (_, index) => ({ taskId: `t${index + 1}`, arm: 'A', repeat: 1 }))

test('planned 3, executed 2, passed 1: delivery 1/3 and gradable 1/2 each bind their own interval', () => {
  const [arm] = summarizeTrials(plan(3), [
    { taskId: 't1', arm: 'A', repeat: 1, verdict: 'pass' },
    { taskId: 't2', arm: 'A', repeat: 1, verdict: 'fail' },
  ])
  assert.equal(arm!.delivery.passed, 1)
  assert.equal(arm!.delivery.denominator, 3)
  assert.deepEqual(arm!.delivery.wilson95, wilsonInterval(1, 3))
  assert.equal(arm!.gradable.denominator, 2)
  assert.deepEqual(arm!.gradable.wilson95, wilsonInterval(1, 2))
  assert.notDeepEqual(arm!.delivery.wilson95, arm!.gradable.wilson95)
  assert.equal(arm!.coverage.notExecuted, 1)
})

test('unknown trials leave the gradable denominator and show up by reason', () => {
  const [arm] = summarizeTrials(plan(4), [
    { taskId: 't1', arm: 'A', repeat: 1, verdict: 'pass' },
    { taskId: 't2', arm: 'A', repeat: 1, verdict: 'unknown', reason: 'grader_error' },
    { taskId: 't3', arm: 'A', repeat: 1, verdict: 'unknown', reason: 'infrastructure' },
    { taskId: 't4', arm: 'A', repeat: 1, verdict: 'unknown', reason: 'missing_evidence' },
  ])
  assert.deepEqual(arm!.coverage, { executed: 4, notExecuted: 0, infrastructure: 1, grader_error: 1, missing_evidence: 1 })
  assert.equal(arm!.gradable.denominator, 1)
  assert.equal(arm!.failed, 0)
  assert.equal(arm!.delivery.denominator, 4)
})

test('duplicate records, out-of-plan records and reasonless unknowns throw with the key', () => {
  const record: TrialRecord = { taskId: 't1', arm: 'A', repeat: 1, verdict: 'pass' }
  assert.throws(() => summarizeTrials(plan(2), [record, record]), /duplicate record: t1:A:1/)
  assert.throws(() => summarizeTrials(plan(2), [{ ...record, taskId: 'zz' }]), /outside the planned trials: zz:A:1/)
  assert.throws(() => summarizeTrials([...plan(1), ...plan(1)], []), /duplicate planned trial: t1:A:1/)
  assert.throws(() => summarizeTrials(plan(1), [{ taskId: 't1', arm: 'A', repeat: 1, verdict: 'unknown' } as unknown as TrialRecord]), /needs a reason/)
  assert.throws(() => summarizeTrials(plan(1), [{ ...record, reason: 'grader_error' } as unknown as TrialRecord]), /only unknown verdicts/)
})

test('nothing executed: delivery 0/planned, gradable has no rate and the full-range interval', () => {
  const [arm] = summarizeTrials(plan(3), [])
  assert.equal(arm!.delivery.passed, 0)
  assert.equal(arm!.delivery.denominator, 3)
  assert.equal(arm!.gradable.denominator, 0)
  assert.equal(arm!.gradable.rate, null)
  assert.deepEqual(arm!.gradable.wilson95, { low: 0, high: 1 })
  assert.equal(arm!.coverage.notExecuted, 3)
})

test('public orchestration sample normalizes to S 2/4, D 2/4, R 4/4, R-serial 4/4', () => {
  const sample = JSON.parse(fs.readFileSync(new URL('../../docs/samples/orchestration-four-arm-20261108.json', import.meta.url), 'utf8')) as { runs: { runId: string; status: string; hiddenPassed: boolean }[] }
  const arms = summarizeTrials(orchestrationPlanned(assembleRunMatrix()), orchestrationRecords(sample.runs))
  const passed = Object.fromEntries(arms.map(arm => [arm.arm, `${arm.delivery.passed}/${arm.delivery.denominator}`]))
  assert.deepEqual(passed, { S: '2/4', D: '2/4', R: '4/4', 'R-serial': '4/4' })
  for (const arm of arms) assert.equal(arm.coverage.notExecuted, 0)
})

test('orchestration adapter: infrastructure_error and a null verifier exit code are unknown, not failures', () => {
  const records = orchestrationRecords([
    { runId: 'a:S:1', status: 'infrastructure_error', hidden: { passed: false, results: [] } },
    { runId: 'a:S:2', status: 'completed', hidden: { passed: false, results: [{ exitCode: null }] } },
    { runId: 'a:D:1', status: 'completed', hidden: { passed: true, results: [{ exitCode: 0 }] } },
    { runId: 'a:D:2', status: 'completed', hidden: { passed: false, results: [{ exitCode: 1 }] } },
    { runId: 'a:R:1', status: 'completed' },
  ])
  assert.deepEqual(records.map(record => record.verdict === 'unknown' ? record.reason : record.verdict), ['infrastructure', 'grader_error', 'pass', 'fail', 'missing_evidence'])
  assert.throws(() => orchestrationRecords([{ runId: 'bad', status: 'completed' }]), /task:arm:repeat/)
})

test('SWE adapter maps infrastructure, scoring errors and missing scores to unknown, never to fail', () => {
  const manifest = { development: { schedule: [] }, formal: { schedule: ['i1', 'i2', 'i3', 'i4', 'i5'].map(instanceId => ({ instanceId, armId: 'x' })) } } as unknown as SwebenchRunManifest
  const run = (instanceId: string, status: string) => ({ instanceId, armId: 'x', status, resolved: false }) as unknown as SwebenchEpisodeResult
  const score = (instanceId: string, classification: string) => ({ armId: 'x', instanceId, resolved: classification === 'resolved', classification, scoreRunId: 's' })
  const scores = { runIds: {}, results: [score('i1', 'resolved'), score('i2', 'unresolved'), score('i3', 'error')] } as unknown as SwebenchScores
  const { planned, records } = sweTrials(manifest, 'formal', [run('i1', 'completed'), run('i2', 'completed'), run('i3', 'completed'), run('i4', 'infrastructure'), run('i5', 'completed')], scores)
  assert.equal(planned.length, 5)
  assert.deepEqual(records.map(record => record.verdict === 'unknown' ? record.reason : record.verdict), ['pass', 'fail', 'grader_error', 'infrastructure', 'missing_evidence'])
  const [arm] = summarizeTrials(planned, records)
  assert.equal(arm!.failed, 1)
  assert.equal(arm!.gradable.denominator, 2)
})

test('SWE adapter rejects duplicate and out-of-plan scores in either order instead of letting the last one win', () => {
  const manifest = { development: { schedule: [] }, formal: { schedule: [{ instanceId: 'i1', armId: 'x' }] } } as unknown as SwebenchRunManifest
  const run = [{ instanceId: 'i1', armId: 'x', status: 'completed', resolved: false }] as unknown as SwebenchEpisodeResult[]
  const score = (instanceId: string, classification: string, armId = 'x') => ({ armId, instanceId, resolved: classification === 'resolved', classification, scoreRunId: 's' })
  const scoresOf = (...results: ReturnType<typeof score>[]) => ({ runIds: {}, results }) as unknown as SwebenchScores
  assert.throws(() => sweTrials(manifest, 'formal', run, scoresOf(score('i1', 'unresolved'), score('i1', 'resolved'))), /duplicate score: x\/i1/)
  assert.throws(() => sweTrials(manifest, 'formal', run, scoresOf(score('i1', 'resolved'), score('i1', 'unresolved'))), /duplicate score: x\/i1/)
  assert.throws(() => sweTrials(manifest, 'formal', run, scoresOf(score('i9', 'resolved'))), /score outside the planned trials: x\/i9/)
  assert.throws(() => sweTrials(manifest, 'formal', run, scoresOf(score('i1', 'resolved', 'y'))), /outside the planned trials: y\/i1/)
})
