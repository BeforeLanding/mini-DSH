import fs from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { encryptFile } from './swe-evidence.mjs'

const json = value => JSON.stringify(value, null, 2) + '\n'
const present = file => fs.stat(file).then(() => true, () => false)
const inputs = process.env.SWE_INPUT_ROOT, evidence = process.env.SWE_EVIDENCE_ROOT, output = process.env.SWE_PUBLIC_ROOT
if (!inputs || !evidence || !output) throw new Error('missing evidence directories')
await fs.mkdir(output, { recursive: true })
const inputMetadata = path.join(inputs, 'input-metadata.json')
if (await present(inputMetadata)) await fs.copyFile(inputMetadata, path.join(output, 'input-metadata.json'))
const context = { manifestSha256: process.env.SWE_EXPECTED_SHA256, sourceCommit: '027236b85573ac6cfdffae0fd09f9206ab975480',
  runId: process.env.GITHUB_RUN_ID, workflowCommit: process.env.GITHUB_SHA, batch: 'swe-components-dev-20261030' }
const reportPath = path.join(evidence, 'report.json')
if (await present(reportPath)) {
  const report = JSON.parse(await fs.readFile(reportPath, 'utf8'))
  const fields = ['armId', 'system', 'planned', 'executed', 'unexecuted', 'scored', 'resolvedOverPlanned', 'resolvedRateOverPlanned',
    'wilson95', 'budgetStops', 'failed', 'timeouts', 'statusCounts', 'knownCostUsd', 'unknownCostEpisodes', 'tokens', 'components', 'tokenBudget']
  const summary = { kind: 'swe-component-development-public-summary', ...context, plannedEpisodes: report.plannedEpisodes,
    executedEpisodes: report.executedEpisodes, batch: report.batch,
    perArm: report.perArm.map(arm => Object.fromEntries(fields.filter(key => arm[key] !== undefined).map(key => [key, arm[key]]))),
    paired: report.paired, componentComparisons: report.componentComparisons, scoring: report.scoring,
    note: 'Development observations are descriptive. Raw prompts, tool bodies and traces are encrypted separately.' }
  await fs.writeFile(path.join(output, 'summary.json'), json(summary))
}
const log = process.env.SWE_EXECUTION_LOG
if (await present(evidence) || (log && await present(log))) {
  const archive = path.join(path.dirname(output), 'swe-raw-private.tar.gz')
  const args = ['--exclude=*/workspace', '--exclude=*/external/dataset', '-czf', archive]
  if (await present(evidence)) args.push('-C', path.dirname(evidence), path.basename(evidence))
  if (log && await present(log)) args.push('-C', path.dirname(log), path.basename(log))
  const packed = spawnSync('tar', args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024 })
  if (packed.status !== 0) throw new Error(`raw evidence packaging failed: ${packed.error?.message ?? packed.stderr.slice(-500)}`)
  await fs.chmod(archive, 0o600)
  try {
    await encryptFile(archive, await fs.readFile(process.env.SWE_EVIDENCE_PUBLIC_KEY ?? '.github/evidence/swe-development-20261030-public.pem', 'utf8'),
      path.join(output, 'raw-evidence.tar.gz.enc'), context)
  } finally { await fs.rm(archive, { force: true }) }
}
console.log('public aggregate metadata and encrypted raw evidence prepared')
