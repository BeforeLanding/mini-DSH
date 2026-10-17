import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertEvidenceRootUnused, calibrationTasks, developmentTasks, formalTasks, parseV2Arguments, resolveV2Arms, resolveV2Episodes, resolveV2Plan } from '../scripts/eval-v2-plan.js'

test('V2 plans complete matched blocks with explicit repeats and shared resource limits', () => {
  assert.equal(formalTasks.length, 20)
  assert.equal(new Set(formalTasks.map(task => task.id)).size, 20)
  assert.equal(calibrationTasks.length, 5)
  for (const family of ['comprehension', 'bugfix', 'feature', 'refactor', 'mutation']) {
    assert.equal(formalTasks.filter(task => task.family === family).length, 4)
    assert.equal(calibrationTasks.filter(task => task.family === family).length, 1)
  }
  const formal = resolveV2Episodes('formal'), calibration = resolveV2Episodes('calibration')
  assert.equal(formal.length, 240)
  assert.equal(calibration.length, 20)
  for (const block of new Set(formal.map(episode => episode.block))) {
    const members = formal.filter(episode => episode.block === block)
    assert.deepEqual(new Set(members.map(episode => episode.arm)), new Set(['baseline', 'context', 'prompt', 'full']))
    assert.equal(new Set(members.map(episode => episode.taskId)).size, 1)
    assert.equal(new Set(members.map(episode => episode.repeat)).size, 1)
  }
  const arms = resolveV2Arms(1_000_000, '2m')
  for (const arm of arms) {
    assert.equal(arm.budget.maxModelRequests, 64)
    assert.equal(arm.budget.maxToolCalls, 128)
    assert.equal(arm.budget.maxActiveDurationMs, 600_000)
    assert.equal(arm.budget.maxTotalTokens, 2_000_000)
  }
  assert.equal(arms[0]!.budget.inputTargetTokens, 1_000_000)
  assert.equal(arms[1]!.budget.inputTargetTokens, 65_536)
  assert.equal(arms[0]!.promptLayout.frozen, false)
  assert.equal(arms[2]!.promptLayout.frozen, true)
  assert.equal(arms[0]!.toolOutput.bounded, false)
  assert.equal(arms[3]!.toolOutput.bounded, true)
  assert.deepEqual(resolveV2Plan({ split: 'formal', tier: '2m', window: 1_000_000, evidenceRoot: 'unused', planOnly: true }).caps,
    { runs: 240, modelRequests: 15_360, toolCalls: 30_720, totalTokens: 480_000_000, activeDurationMs: 144_000_000 })
})

test('development protocol fixes six structurally selected roots, 24 paired episodes and balanced arm order', () => {
  assert.deepEqual(developmentTasks.map(task => task.id), ['UC01', 'BC01', 'FC01', 'RC01', 'TC01', 'U01'])
  assert.equal(new Set(developmentTasks.map(task => task.family)).size, 5)
  assert.deepEqual(new Set(developmentTasks.map(task => task.shape)), new Set(['multi-stage', 'information', 'single']))
  const episodes = resolveV2Episodes('development')
  assert.equal(episodes.length, 24)
  assert.equal(new Set(episodes.map(row => `${row.taskId}/${row.repeat}/${row.arm}`)).size, 24)
  for (const block of new Set(episodes.map(row => row.block))) {
    const pair = episodes.filter(row => row.block === block)
    assert.deepEqual(new Set(pair.map(row => row.arm)), new Set(['baseline', 'full']))
    assert.equal(new Set(pair.map(row => `${row.taskId}/${row.repeat}`)).size, 1)
  }
  assert.equal(episodes.filter((row, index) => index % 2 === 0 && row.arm === 'baseline').length, 6)
  assert.deepEqual(resolveV2Plan({ split: 'development', tier: '1m', window: 1_000_000, evidenceRoot: 'unused', planOnly: true }).caps,
    { runs: 24, modelRequests: 1536, toolCalls: 3072, totalTokens: 24_000_000, activeDurationMs: 14_400_000 })
  assert.throws(() => parseV2Arguments(['--split', 'development', '--tier', '2m', '--window', '1000000', '--evidence-root', 'unused']), /shared 1m/)
})

test('V2 refuses ambiguous or colliding paid-plan configuration before effects', () => {
  const valid = ['--split', 'formal', '--tier', '2m', '--window', '1000000', '--evidence-root', path.join(os.tmpdir(), 'nx42-unused'), '--plan-only']
  const parsed = parseV2Arguments(valid)
  assert.equal(parsed.split, 'formal')
  assert.equal(parsed.planOnly, true)
  assert.throws(() => parseV2Arguments([...valid, '--unknown']), /unknown option/)
  assert.throws(() => parseV2Arguments([...valid, '--split', 'calibration']), /duplicate option/)
  assert.throws(() => parseV2Arguments(valid.filter((_, i) => i !== 2 && i !== 3)), /--tier must/)
  assert.throws(() => parseV2Arguments(valid.map(value => value === '1000000' ? '65536' : value)), /must exceed/)
  const occupied = fs.mkdtempSync(path.join(os.tmpdir(), 'nx42-evidence-'))
  try { assert.throws(() => assertEvidenceRootUnused(occupied), /already exists/) }
  finally { fs.rmSync(occupied, { recursive: true, force: true }) }
})
