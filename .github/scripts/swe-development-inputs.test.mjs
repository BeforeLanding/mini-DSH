import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { restoreInputs, writeInputs } from './swe-development-inputs.mjs'

const templatePath = new URL('../../docs/samples/swe-component-development-template-20261030.json', import.meta.url)

async function fixture() {
  const template = JSON.parse(await fs.readFile(templatePath, 'utf8'))
  const manifest = structuredClone(template.manifest)
  const byId = new Map()
  for (const split of ['development', 'formal']) for (const instance of manifest[split].instances) {
    instance.problem_statement = `Synthetic issue ${instance.instance_id}`
    byId.set(instance.instance_id, { ...instance, patch: 'GOLD_MUST_NOT_REACH_AGENT', test_patch: 'SYNTHETIC_TEST_PATCH',
      FAIL_TO_PASS: ['synthetic_missing_behavior'], PASS_TO_PASS: ['synthetic_existing_behavior'], hints_text: 'HIDDEN_HINT' })
  }
  template.manifestSha256 = createHash('sha256').update(JSON.stringify(manifest, null, 2) + '\n').digest('hex')
  return { template, manifest, rows: [...byId.values()] }
}

test('restoration verifies the full frozen bytes and separates agent data from independent grading rows', async () => {
  const { template, manifest, rows } = await fixture()
  const restored = restoreInputs(template, rows, template.manifestSha256)
  assert.equal(restored.manifestJson, JSON.stringify(manifest, null, 2) + '\n')
  assert.equal(restored.agentRows.length, 5)
  assert.equal(restored.scoringRows.length, 5)
  assert.ok(!JSON.stringify(restored.agentRows).includes('GOLD_MUST_NOT_REACH_AGENT'))
  assert.ok(!JSON.stringify(restored.agentRows).includes('SYNTHETIC_TEST_PATCH'))
  assert.ok(!JSON.stringify(restored.agentRows).includes('HIDDEN_HINT'))
  assert.ok(restored.scoringRows.every(row => !('patch' in row) && !('problem_statement' in row)))
})

test('changed task bodies, identity drift, missing scoring rows and duplicate dataset ids fail closed', async () => {
  const { template, rows } = await fixture()
  const changed = structuredClone(rows)
  changed[0].problem_statement += ' changed'
  assert.throws(() => restoreInputs(template, changed, template.manifestSha256), /manifest hash/)
  const drift = structuredClone(rows)
  drift[0].base_commit = '0'.repeat(40)
  assert.throws(() => restoreInputs(template, drift, template.manifestSha256), /identity drift/)
  const ungraded = structuredClone(rows)
  delete ungraded[0].test_patch
  assert.throws(() => restoreInputs(template, ungraded, template.manifestSha256), /scoring rows/)
  assert.throws(() => restoreInputs(template, [...rows, rows[0]], template.manifestSha256), /duplicate/)
})

test('filesystem preparation never overwrites a stopped attempt and bad hashes create no output', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'swe development inputs '))
  try {
    const { template, rows } = await fixture()
    const output = path.join(directory, 'private inputs')
    const metadata = await writeInputs(template, rows, template.manifestSha256, output)
    assert.equal(metadata.plannedEpisodes, 30)
    assert.equal(metadata.paidRequests, 0)
    await assert.rejects(writeInputs(template, rows, template.manifestSha256, output), /EEXIST/)
    const bad = path.join(directory, 'bad inputs')
    await assert.rejects(writeInputs(template, rows, '0'.repeat(64), bad), /template identity/)
    assert.equal(await fs.stat(bad).then(() => true, () => false), false)
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})
