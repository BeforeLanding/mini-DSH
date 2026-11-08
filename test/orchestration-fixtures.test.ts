import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  evaluateOrchestrationFixture, fixturePlan, materializeOrchestrationFixture, orchestrationFixtureIds,
  orchestrationFixtures, validateOrchestrationFixture,
} from '../scripts/orchestration-fixtures.js'

// 组合夹具门禁：初始态必须被隐藏验收器拒绝，参考态必须通过；计划必须按依赖分层；
// 隐藏验收器不得进入工作区，计划验收命令只使用工作区内相对路径。
test('every orchestration fixture rejects its initial state and accepts its reference state', async () => {
  for (const id of orchestrationFixtureIds) {
    const report = await validateOrchestrationFixture(id)
    assert.equal(report.initialRejected, true, `${id} initial state must fail`)
    assert.equal(report.referenceAccepted, true, `${id} reference state must pass`)
    assert.ok(report.commands.length >= orchestrationFixtures[id].tasks.length)
  }
})

test('the composite plan splits into two waves and hides the boundary verifier', async () => {
  const report = await validateOrchestrationFixture('parallel-composite')
  assert.equal(report.mode, 'parallel')
  assert.deepEqual(report.waves, [['st-1', 'st-2'], ['st-3']])
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-fixture-gate-'))
  try {
    await materializeOrchestrationFixture('parallel-composite', root)
    for (const task of orchestrationFixtures['parallel-composite'].tasks) {
      assert.equal(task.verify.script.startsWith(root + path.sep), false)
      assert.equal(await fs.stat(task.verify.script).then(() => true, () => false), true)
      assert.equal(task.verify.marker.startsWith('acceptance passed:'), true)
    }
    // 工作区只有冒烟检查，没有隐藏验收器的副本。
    assert.equal(await fs.stat(path.join(root, 'packages/normalize/check.mjs')).then(() => true, () => false), true)
    assert.equal(await fs.stat(path.join(root, 'packages/report/src/report.mjs')).then(() => true, () => false), false)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('the single-repair plan runs one worker and keeps its check local', async () => {
  const report = await validateOrchestrationFixture('single-repair')
  assert.equal(report.mode, 'single')
  assert.deepEqual(report.waves, [['st-1']])
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-fixture-single-'))
  try {
    await materializeOrchestrationFixture('single-repair', root)
    assert.equal(await fs.stat(path.join(root, 'check.mjs')).then(() => true, () => false), true)
    assert.equal(await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8').then(text => text.length > 0), true)
    const rejected = await evaluateOrchestrationFixture('single-repair', root)
    assert.equal(rejected.passed, false)
    assert.equal(rejected.results[0]?.exitCode === 0, false)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('plan acceptance commands are workspace-relative and runnable on the integration worktree', () => {
  for (const id of orchestrationFixtureIds) for (const subtask of fixturePlan(id).subtasks) {
    const command = subtask.acceptance.commands[0]!
    assert.match(command, /^node [\w./-]+$/)
    assert.equal(path.isAbsolute(command.split(' ')[1]!), false, `${id}/${subtask.id} must stay relative`)
  }
})
