import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertSanitizedInstances, sanitizeInstanceRow, validateRunManifest } from '../../dist/scripts/swebench/protocol.js'
import { assertComponentSource } from '../../dist/scripts/swebench/component-protocol.js'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const json = value => JSON.stringify(value, null, 2) + '\n'

// The committed template contains metadata and a marker, never issue bodies or
// grading data. Restore the original bytes from the pinned public dataset and
// verify the reviewed full-manifest hash before any model credential is needed.
export function restoreInputs(template, rows, expectedSha256) {
  if (template.schemaVersion !== 1 || template.kind !== 'swe-component-development-input-template'
    || !/^[a-f0-9]{64}$/.test(expectedSha256) || template.manifestSha256 !== expectedSha256) throw new Error('unexpected frozen template identity')
  if (!Array.isArray(rows)) throw new Error('dataset rows must be an array')
  const byId = new Map()
  for (const row of rows) {
    if (!row || typeof row.instance_id !== 'string' || byId.has(row.instance_id)) throw new Error('missing or duplicate dataset identity')
    byId.set(row.instance_id, row)
  }
  const manifest = structuredClone(template.manifest)
  for (const split of ['development', 'formal']) for (const instance of manifest[split].instances) {
    const row = byId.get(instance.instance_id)
    if (!row || instance.problem_statement !== template.problemMarker || typeof row.problem_statement !== 'string') throw new Error('missing public task body or invalid marker')
    for (const key of Object.keys(instance).filter(key => key !== 'problem_statement')) {
      if (row[key] !== instance[key]) throw new Error(`dataset identity drift: ${instance.instance_id}/${key}`)
    }
    instance.problem_statement = row.problem_statement
  }
  const manifestJson = json(manifest)
  if (hash(manifestJson) !== expectedSha256) throw new Error('restored manifest hash differs from the reviewed batch')
  const validated = validateRunManifest(manifest)
  if (validated.executionScope !== 'development' || validated.development.schedule.length !== 30 || validated.caps.batch.maxCostUsd !== 17) throw new Error('batch scope differs from the authorized development run')
  const agentRows = assertSanitizedInstances(validated.development.instances.map(instance => sanitizeInstanceRow(byId.get(instance.instance_id))))
  assert.deepEqual(agentRows, validated.development.instances)
  const scoreFields = ['instance_id', 'repo', 'base_commit', 'version', 'environment_setup_commit', 'test_patch', 'FAIL_TO_PASS', 'PASS_TO_PASS']
  const scoringRows = validated.development.instances.map(instance => {
    const raw = byId.get(instance.instance_id)
    if (typeof raw.test_patch !== 'string' || raw.FAIL_TO_PASS === undefined || raw.PASS_TO_PASS === undefined) throw new Error(`missing independent scoring rows for ${instance.instance_id}`)
    return Object.fromEntries(scoreFields.filter(key => raw[key] !== undefined).map(key => [key, raw[key]]))
  })
  return { manifest: validated, manifestJson, agentRows, scoringRows }
}

export async function writeInputs(template, rows, expectedSha256, output) {
  const restored = restoreInputs(template, rows, expectedSha256)
  assertComponentSource(restored.manifest)
  // An existing directory is a stopped attempt, never an invitation to rewrite
  // the inputs or silently resume it. Grading rows stay outside all workspaces.
  await fs.mkdir(output, { mode: 0o700 })
  for (const [name, bytes] of [['manifest.json', restored.manifestJson], ['dataset.agent.json', json(restored.agentRows)],
    ['dataset.scoring.json', json(restored.scoringRows)]]) {
    await fs.writeFile(path.join(output, name), bytes, { flag: 'wx', mode: 0o600 })
  }
  const metadata = { kind: 'swe-component-restored-inputs', manifestSha256: expectedSha256,
    sourceCommit: restored.manifest.selection.sourceCommit, scope: restored.manifest.executionScope,
    tasks: restored.agentRows.map(row => row.instance_id), arms: restored.manifest.development.arms,
    plannedEpisodes: restored.manifest.development.schedule.length, batchCapUsd: 17, paidRequests: 0 }
  await fs.writeFile(path.join(output, 'input-metadata.json'), json(metadata), { flag: 'wx', mode: 0o600 })
  return metadata
}

function argument(name) {
  const index = process.argv.indexOf(name)
  const value = index < 0 ? undefined : process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`missing ${name}`)
  return value
}

async function main() {
  const template = JSON.parse(await fs.readFile(argument('--template'), 'utf8'))
  const rows = JSON.parse(await fs.readFile(argument('--rows'), 'utf8'))
  const result = await writeInputs(template, rows, argument('--expected-sha256'), path.resolve(argument('--output')))
  console.log(JSON.stringify(result))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
