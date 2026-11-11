import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { checkRegrade, regradeAll, regradeCase, regradeRoot } from '../scripts/eval-regrade.js'
import type { RegradeCase } from '../scripts/eval-regrade.js'
import { orchestrationFixtures } from '../scripts/orchestration-fixtures.js'

const batch01 = path.join(regradeRoot, 'batch01-parallel-composite-S-1')
const readCase = async (directory: string) => JSON.parse(await fs.readFile(path.join(directory, 'case.json'), 'utf8')) as RegradeCase

async function withCopy<T>(run: (directory: string) => Promise<T>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'regrade-test-'))
  try {
    const directory = path.join(root, 'case')
    await fs.cp(batch01, directory, { recursive: true })
    return await run(directory)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}
const digestTree = async (directory: string): Promise<Record<string, string>> => {
  const out: Record<string, string> = {}
  const walk = async (current: string) => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) await walk(full)
      else out[path.relative(directory, full)] = createHash('sha256').update(await fs.readFile(full)).digest('hex')
    }
  }
  await walk(directory)
  return out
}

test('batch-01 S/1 still fails st-3 under the current grader, and the verdict matches the expectation', async () => {
  const spec = await readCase(batch01)
  const grade = await regradeCase(batch01)
  assert.equal(grade.verdict, 'fail')
  assert.deepEqual(grade.failedTasks, ['st-3'])
  assert.deepEqual(grade.tasks.map(task => task.passed), [true, true, false])
  assert.equal(grade.runId, 'parallel-composite:S:1')
  assert.match(grade.annotation, /spec-asymmetry; batch comparison not supported/)
  assert.equal(spec.validates, 'grader')
  assert.ok(Object.values(grade.graderSha256).every(digest => typeof digest === 'string'))
  assert.equal(checkRegrade(grade, spec.expected).passed, true)
})

test('the grader is not loosened: expecting a pass for the historical artifact is reported as a mismatch', async () => {
  const grade = await regradeCase(batch01)
  assert.equal(checkRegrade(grade, { verdict: 'pass', failedTasks: [] }).passed, false)
  assert.equal(checkRegrade(grade, { verdict: 'fail', failedTasks: ['st-1'] }).passed, false)
})

test('the revised fixture goal (ET-2) does not change the verdict on the old artifact', async () => {
  // 补齐规格只影响以后的批次：goal 现在含该条款，而 batch-01 的旧产物仍然判失败。
  const clause = orchestrationFixtures['parallel-composite'].requiredClauses[0]!
  assert.ok(orchestrationFixtures['parallel-composite'].goal.includes(clause.text))
  assert.equal((await regradeCase(batch01)).verdict, 'fail')
})

test('the committed sample is minimal: sources, index and package.json only, no tool output', async () => {
  const spec = await readCase(batch01)
  for (const file of Object.keys(spec.files)) assert.match(file, /^packages\/[a-z]+\/(src\/[\w.-]+\.mjs|index\.mjs|package\.json)$/)
  const onDisk = Object.keys(await digestTree(path.join(batch01, 'sample'))).map(file => file.split(path.sep).join('/'))
  assert.deepEqual(onDisk.sort(), Object.keys(spec.files).sort())
  assert.ok(!onDisk.some(file => file.includes('.mini-dsh')))
  assert.match(spec.source.runJsonSha256, /^[a-f0-9]{64}$/)
})

test('regrading never modifies the recorded case', async () => {
  const before = await digestTree(batch01)
  await regradeCase(batch01)
  assert.deepEqual(await digestTree(batch01), before)
})

test('unknown / missing_evidence: a removed acceptance target file is reported, not graded as a failure', async () => {
  await withCopy(async directory => {
    await fs.rm(path.join(directory, 'sample/packages/report/src/report.mjs'))
    const grade = await regradeCase(directory)
    assert.equal(grade.verdict, 'unknown')
    assert.equal(grade.reason, 'missing_evidence')
    assert.match(grade.detail ?? '', /report\.mjs/)
    assert.equal(checkRegrade(grade, { verdict: 'fail', failedTasks: ['st-3'] }).passed, false)
  })
})

test('unknown / incompatible: an unknown fixture id and an altered sample are not graded', async () => {
  await withCopy(async directory => {
    const spec = await readCase(directory)
    await fs.writeFile(path.join(directory, 'case.json'), JSON.stringify({ ...spec, fixture: 'no-such-fixture' }))
    const grade = await regradeCase(directory)
    assert.equal(grade.verdict, 'unknown')
    assert.equal(grade.reason, 'incompatible')
    assert.match(grade.detail ?? '', /no-such-fixture/)
  })
  await withCopy(async directory => {
    await fs.appendFile(path.join(directory, 'sample/packages/report/src/report.mjs'), '// tampered\n')
    const grade = await regradeCase(directory)
    assert.equal(grade.reason, 'incompatible')
    assert.match(grade.detail ?? '', /changed since/)
  })
})

test('unknown / grader_error: a missing grader script and a grader that cannot finish are not task failures', async () => {
  const tasks = orchestrationFixtures['parallel-composite'].tasks
  const missing = await regradeCase(batch01, { tasks: tasks.map(task => ({ ...task, verify: { ...task.verify, script: path.join(os.tmpdir(), 'no-such-verifier.mjs') } })) })
  assert.equal(missing.verdict, 'unknown')
  assert.equal(missing.reason, 'grader_error')
  assert.match(missing.detail ?? '', /does not exist/)
  const timedOut = await regradeCase(batch01, { timeoutMs: 1 })
  assert.equal(timedOut.verdict, 'unknown')
  assert.equal(timedOut.reason, 'grader_error')
  assert.deepEqual(timedOut.failedTasks.length > 0, true)
  assert.equal(checkRegrade(timedOut, { verdict: 'fail', failedTasks: ['st-3'] }).passed, false)
})

test('every committed regrade case matches its expected verdict (what pnpm eval:regrade checks in CI)', async () => {
  const outcomes = await regradeAll()
  assert.ok(outcomes.length >= 1)
  for (const outcome of outcomes) assert.equal(outcome.passed, true, `${outcome.case}: ${outcome.reason}`)
})
