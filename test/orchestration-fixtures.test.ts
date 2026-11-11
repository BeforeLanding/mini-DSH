import test from 'node:test'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  evaluateOrchestrationFixture, fixturePlan, materializeOrchestrationFixture, orchestrationFixtureIds,
  orchestrationFixtures, validateOrchestrationFixture,
  checkClauseVisibility, materializeWeakFixture,
} from '../scripts/orchestration-fixtures.js'
import { assembleRunMatrix, validateRunMatrix } from '../scripts/eval-orchestrate.js'

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

test('every arm of every assembled run can see the registered required clauses', () => {
  for (const spec of assembleRunMatrix()) {
    const check = checkClauseVisibility(spec)
    assert.deepEqual(check.errors, [], spec.runId)
    assert.equal(check.passed, true)
  }
  assert.ok(orchestrationFixtureIds.every(id => orchestrationFixtures[id].requiredClauses.length > 0))
})

test('removing the st-3 names clause from the goal fails the visibility check and the matrix validation', () => {
  const clause = orchestrationFixtures['parallel-composite'].requiredClauses[0]!
  const stripped = assembleRunMatrix().map(spec => spec.taskId === 'parallel-composite' ? { ...spec, goal: spec.goal.replace(clause.text, '').trim() } : spec)
  const failing = stripped.filter(spec => !checkClauseVisibility(spec).passed)
  assert.deepEqual([...new Set(failing.map(spec => spec.arm))].sort(), ['D', 'R', 'R-serial', 'S'])
  // 即便 R/R-serial 的计划 objective 仍含相同语义，goal 缺条款也判失败：四臂规格必须来自同一段 goal。
  assert.match(checkClauseVisibility(failing.find(spec => spec.arm === 'S')!).errors[0]!, /report-names-keep-duplicates.*not visible/)
  const validation = validateRunMatrix(stripped)
  assert.equal(validation.passed, false)
  assert.ok(validation.errors.some(error => error.includes('report-names-keep-duplicates')))
})

test('a clause that only the plan objective carries does not count for S/D and is flagged for R', () => {
  const clause = orchestrationFixtures['parallel-composite'].requiredClauses[0]!
  const r = assembleRunMatrix().find(spec => spec.taskId === 'parallel-composite' && spec.arm === 'R')!
  const onlyInPlan = { ...r, goal: 'Fix everything.', plan: { ...r.plan!, subtasks: r.plan!.subtasks.map((subtask, index) => index === 0 ? { ...subtask, objective: `${subtask.objective} ${clause.text}` } : subtask) } }
  assert.match(checkClauseVisibility(onlyInPlan).errors[0]!, /missing from the goal/)
})

test('each weak counter-example is rejected by the hidden verifier, and only for the intended reason', async () => {
  for (const id of orchestrationFixtureIds) {
    const report = await validateOrchestrationFixture(id)
    assert.equal(report.weakRejected, true, `${id} weak counter-example must fail the hidden verifier`)
  }
  // 复合夹具的反例只在 st-3 上失败：前两个包用的是参考解。
  assert.deepEqual((await validateOrchestrationFixture('parallel-composite')).weakFailedTasks, ['st-3'])
  assert.deepEqual((await validateOrchestrationFixture('single-repair')).weakFailedTasks, ['st-1'])
})

test('weak counter-examples pass the public smoke checks, so only the hidden verifier can tell them apart', async () => {
  for (const id of orchestrationFixtureIds) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `orch-weak-${id}-`))
    try {
      await materializeWeakFixture(id, root)
      for (const task of orchestrationFixtures[id].tasks) {
        const [, script] = task.check.split(' ')
        const run = spawnSync(process.execPath, [script!], { cwd: root, encoding: 'utf8', timeout: 30_000 })
        assert.equal(run.status, 0, `${id}/${task.id} public check should accept the weak implementation: ${run.stdout}${run.stderr}`)
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  }
})

test('offline validation requires weakRejected for every fixture', async () => {
  const { validateOfflineBatch } = await import('../scripts/eval-orchestrate.js')
  const batch = await validateOfflineBatch()
  assert.equal(batch.passed, true)
  assert.ok(batch.tasks.every(task => task.weakRejected))
})
