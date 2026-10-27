import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const baseline = new URL('../../docs/samples/components-baseline.json', import.meta.url)
const script = fileURLToPath(new URL('../../scripts/benchmark-components.mjs', import.meta.url))

test('component baseline retains the reviewed source, protocol and measurement bytes', async () => {
  const bytes = await fs.readFile(baseline)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), '99de97fdad7368b11db1a3e225955fb54e54e207a5c8ce9d3e926ba69f506174')
  const report = JSON.parse(bytes.toString('utf8'))
  assert.equal(report.sourceCommit, '74f8e89721820ef514e26df71cbb05e0c69683c7')
  assert.equal(report.evidenceKind, 'offline-mechanism')
  assert.equal(createHash('sha256').update(await fs.readFile(script)).digest('hex'), report.suiteSha256)
})

test('unaffected component probes still improve the frozen baseline', { timeout: 60_000 }, () => {
  for (const component of ['compaction', 'reports']) {
    const result = spawnSync(process.execPath, [script, '--compare', fileURLToPath(baseline), '--component', component], { cwd: root, encoding: 'utf8', timeout: 50_000 })
    assert.equal(result.status, 0, result.stderr || String(result.error))
    const report = JSON.parse(result.stdout)
    assert.deepEqual(report.comparisonPassed, [component])
    assert.equal(report.providerRequests, 0)
  }
})

test('reverted preview keeps full recall but no longer satisfies both bounded windows', { timeout: 60_000 }, () => {
  const result = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8', timeout: 50_000 })
  assert.equal(result.status, 0, result.stderr || String(result.error))
  const report = JSON.parse(result.stdout)
  assert.equal(report.providerRequests, 0)
  assert.equal(report.tools.length, 12); assert.equal(report.compaction.length, 3); assert.equal(report.reports.length, 3)
  assert.equal(report.tools.every((item: { fullRecall: boolean }) => item.fullRecall), true)
  assert.equal(report.tools.some((item: { withinLimit: boolean; tailVisible: boolean }) => !item.withinLimit || !item.tailVisible), true)
})
