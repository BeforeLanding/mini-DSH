import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildOrchestrationReport } from '../scripts/eval-orchestration-report.js'
import { regradeRoot } from '../scripts/eval-regrade.js'

const script = fileURLToPath(new URL('../scripts/eval-orchestration-report.js', import.meta.url))
const task = 'parallel-composite'
const reading = (taskId: string, passed: boolean, output: string, exitCode = passed ? 0 : 1) => ({ taskId, command: `verify ${taskId}`, exitCode, output, passed })
const passing = [reading('st-1', true, 'acceptance passed: normalize'), reading('st-2', true, 'acceptance passed: dedupe'), reading('st-3', true, 'acceptance passed: report')]
const failingSt3 = [passing[0]!, passing[1]!, reading('st-3', false, 'AssertionError [ERR_ASSERTION]: describePeople(...)')]
const run = (arm: string, repeat: number, results: ReturnType<typeof reading>[], status = 'completed') => ({ runId: `${task}:${arm}:${repeat}`, taskId: task, arm, repeat, status, hidden: { passed: results.every(item => item.passed), results } })

interface Evidence { root: string; sampleFile: string; cleanup: () => Promise<void> }
// 与 batch-01 同形状的最小证据目录：一个任务、S 与 R 两臂、各 1 次；S 在 st-3 上失败（先去重再列名的那次）。
async function makeEvidence(edit: (parts: { manifest: Record<string, unknown>; report: Record<string, unknown>; runs: Record<string, unknown>[] }) => void = () => {}): Promise<Evidence> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-report-'))
  const parts = {
    manifest: { protocol: 'orchestration-four-arm-v1', gitCommit: 'abc', matrixDigest: 'def', arms: ['S', 'R'], tasks: [task], repeats: 1, runOrder: [`${task}:S:1`, `${task}:R:1`] } as Record<string, unknown>,
    report: { plannedRuns: 2, executedRuns: 2, summary: { byArm: { S: { runs: 1, hiddenPassed: 0 }, R: { runs: 1, hiddenPassed: 1 } } } } as Record<string, unknown>,
    runs: [run('S', 1, failingSt3), run('R', 1, passing)] as Record<string, unknown>[],
  }
  edit(parts)
  await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify(parts.manifest))
  await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(parts.report))
  for (const [index, entry] of parts.runs.entries()) {
    await fs.mkdir(path.join(root, 'runs', `${index + 1}-run`), { recursive: true })
    await fs.writeFile(path.join(root, 'runs', `${index + 1}-run`, 'run.json'), JSON.stringify(entry))
  }
  const digest = async (name: string) => createHash('sha256').update(await fs.readFile(path.join(root, name))).digest('hex')
  const sampleFile = path.join(root, 'public-sample.json')
  await fs.writeFile(sampleFile, JSON.stringify({ manifestSha256: await digest('manifest.json'), reportSha256: await digest('report.json'), byArm: (parts.report.summary as { byArm: unknown }).byArm }))
  return { root, sampleFile, cleanup: () => fs.rm(root, { recursive: true, force: true }) }
}
const failedChecks = (report: Awaited<ReturnType<typeof buildOrchestrationReport>>) => report.checks.filter(item => !item.passed).map(item => item.name)

test('normal historical evidence: recomputed denominators, regrade and caveats, reproducibly', async () => {
  const evidence = await makeEvidence()
  try {
    const first = await buildOrchestrationReport(evidence.root, { publicSample: evidence.sampleFile })
    assert.deepEqual(failedChecks(first), [])
    assert.equal(first.passed, true)
    assert.deepEqual(first.arms.map(arm => `${arm.arm} ${arm.delivery.passed}/${arm.delivery.denominator}`), ['S 0/1', 'R 1/1'])
    assert.equal(first.regrade.length, 1)
    assert.equal(first.regrade[0]!.grade.verdict, 'fail')
    assert.deepEqual(first.regrade[0]!.grade.failedTasks, ['st-3'])
    assert.ok(first.caveats.some(text => text.includes('must not be compared as capability')))
    assert.ok(first.caveats.some(text => text.includes('given plan')))
    assert.match(first.scope, /does not show that a newer agent avoids the mistake/)
    assert.deepEqual(await buildOrchestrationReport(evidence.root, { publicSample: evidence.sampleFile }), first)
  } finally {
    await evidence.cleanup()
  }
})

test('the plan comes from the historical manifest, not from today\'s matrix', async () => {
  const evidence = await makeEvidence()
  try {
    const report = await buildOrchestrationReport(evidence.root)
    assert.equal(report.plannedRuns, 2)
    assert.deepEqual(report.arms.map(arm => arm.arm), ['S', 'R'])
  } finally {
    await evidence.cleanup()
  }
})

test('anomalies block: duplicate run records, grader crash, missing evidence and out-of-plan records', async () => {
  const cases: [string, Parameters<typeof makeEvidence>[0], string[]][] = [
    ['duplicate run record', parts => { parts.runs.push(run('S', 1, passing)) }, ['trials-summarised']],
    ['out-of-plan run record', parts => { parts.runs.push(run('D', 1, passing)) }, ['trials-summarised']],
    ['grader crashed after starting', parts => { parts.runs[0] = run('S', 1, [passing[0]!, passing[1]!, reading('st-3', false, 'TypeError: verifier exploded')]) }, ['every-trial-has-a-verdict']],
    ['planned run has no record', parts => { parts.runs.pop() }, ['every-trial-has-a-verdict', 'original-report-counts', 'original-report-by-arm']],
    ['infrastructure error', parts => { parts.runs[1] = run('R', 1, [], 'infrastructure_error') }, ['every-trial-has-a-verdict', 'original-report-by-arm']],
    ['manifest plan disagrees with tasks x arms x repeats', parts => { parts.manifest.repeats = 2 }, ['manifest-plan-consistent']],
    ['original report disagrees with the raw records', parts => { (parts.report.summary as { byArm: Record<string, { hiddenPassed: number }> }).byArm.R!.hiddenPassed = 0 }, ['original-report-by-arm']],
  ]
  for (const [name, edit, expected] of cases) {
    const evidence = await makeEvidence(edit)
    try {
      const report = await buildOrchestrationReport(evidence.root)
      assert.equal(report.passed, false, name)
      for (const check of expected) assert.ok(failedChecks(report).includes(check), `${name}: expected ${check} to fail, got ${failedChecks(report)}`)
    } finally {
      await evidence.cleanup()
    }
  }
})

test('a public sample that does not match the evidence blocks', async () => {
  const evidence = await makeEvidence()
  try {
    await fs.writeFile(evidence.sampleFile, JSON.stringify({ manifestSha256: 'f'.repeat(64), reportSha256: 'e'.repeat(64), byArm: { S: { runs: 1, hiddenPassed: 1 }, R: { runs: 1, hiddenPassed: 1 } } }))
    const report = await buildOrchestrationReport(evidence.root, { publicSample: evidence.sampleFile })
    assert.deepEqual(failedChecks(report).sort(), ['public-sample-by-arm', 'public-sample-manifest-sha256', 'public-sample-report-sha256'])
  } finally {
    await evidence.cleanup()
  }
})

test('regrade problems block the report: missing sample evidence, and no case for this batch', async () => {
  const evidence = await makeEvidence()
  const copy = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-report-regrade-'))
  try {
    await fs.cp(regradeRoot, copy, { recursive: true })
    await fs.rm(path.join(copy, 'batch01-parallel-composite-S-1', 'sample', 'packages', 'report', 'src', 'report.mjs'))
    const broken = await buildOrchestrationReport(evidence.root, { regradeDirectory: copy })
    assert.ok(failedChecks(broken).includes('regrade-has-no-unknown'))
    assert.ok(failedChecks(broken).includes('regrade-matches-expectation'))
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-report-empty-'))
    try {
      const none = await buildOrchestrationReport(evidence.root, { regradeDirectory: empty })
      assert.ok(failedChecks(none).includes('regrade-cases-for-this-batch'))
    } finally {
      await fs.rm(empty, { recursive: true, force: true })
    }
  } finally {
    await fs.rm(copy, { recursive: true, force: true })
    await evidence.cleanup()
  }
})

test('missing or corrupt manifest is a hard error', async () => {
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-report-nomanifest-'))
  try {
    await assert.rejects(() => buildOrchestrationReport(empty), /manifest\.json is unreadable/)
    await fs.writeFile(path.join(empty, 'manifest.json'), '{ not json')
    await assert.rejects(() => buildOrchestrationReport(empty), /not valid JSON/)
  } finally {
    await fs.rm(empty, { recursive: true, force: true })
  }
})

test('the command exits 0 on normal evidence, non-zero with a reason on anomalies, and never overwrites its output', async () => {
  const good = await makeEvidence()
  const bad = await makeEvidence(parts => { parts.runs.push(run('S', 1, passing)) })
  const outDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-report-out-'))
  try {
    const out = path.join(outDirectory, 'report.json')
    const ok = spawnSync(process.execPath, [script, '--evidence-root', good.root, '--public-sample', good.sampleFile, '--out', out], { encoding: 'utf8' })
    assert.equal(ok.status, 0, ok.stdout + ok.stderr)
    assert.match(ok.stdout, /RESULT: PASS/)
    assert.equal(JSON.parse(await fs.readFile(out, 'utf8')).passed, true)
    const again = spawnSync(process.execPath, [script, '--evidence-root', good.root, '--out', out], { encoding: 'utf8' })
    assert.notEqual(again.status, 0)
    assert.match(again.stderr, /EEXIST|already exists/)
    const failed = spawnSync(process.execPath, [script, '--evidence-root', bad.root], { encoding: 'utf8' })
    assert.equal(failed.status, 1)
    assert.match(failed.stdout, /FAIL trials-summarised: duplicate record: parallel-composite:S:1/)
    assert.match(failed.stdout, /RESULT: FAIL/)
    const missing = spawnSync(process.execPath, [script, '--evidence-root', path.join(outDirectory, 'nowhere')], { encoding: 'utf8' })
    assert.equal(missing.status, 1)
    assert.match(missing.stderr, /FAIL: manifest\.json is unreadable/)
  } finally {
    await good.cleanup()
    await bad.cleanup()
    await fs.rm(outDirectory, { recursive: true, force: true })
  }
})
