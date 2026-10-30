import fs from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

export const BATCH_TITLE = 'SWE-dev-b713df5768dc816a-30-usd17'
export const MANIFEST_SHA256 = 'b713df5768dc816ae39a893e9aba3e73010ec102e8ab34b9426e6f54525f3e82'

export function verifyAttempt(environment) {
  if (environment.GITHUB_EVENT_NAME !== 'workflow_dispatch' || environment.GITHUB_RUN_ATTEMPT !== '1'
    || environment.SWE_APPROVED_MANIFEST !== MANIFEST_SHA256) throw new Error('explicit first-attempt development dispatch and reviewed manifest hash are required')
}

export function verifyHistory(runs, currentId) {
  if (runs.some(run => run.display_title === BATCH_TITLE && String(run.id) !== String(currentId))) {
    throw new Error('this one-time batch already has a dispatched attempt; no automatic rerun')
  }
}

async function main() {
  verifyAttempt(process.env)
  if (!process.env.GH_TOKEN || !process.env.GITHUB_REPOSITORY || !process.env.GITHUB_RUN_ID) throw new Error('missing GitHub run identity')
  const runs = []
  for (let page = 1; ; page++) {
    if (page > 100) throw new Error('workflow history cannot be fully verified')
    const response = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/workflows/ci.yml/runs?event=workflow_dispatch&per_page=100&page=${page}`, {
      headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`workflow history lookup failed: ${response.status}`)
    const data = await response.json()
    if (!Array.isArray(data.workflow_runs)) throw new Error('invalid workflow history')
    runs.push(...data.workflow_runs)
    if (data.workflow_runs.length < 100) break
  }
  verifyHistory(runs, process.env.GITHUB_RUN_ID)
  await fs.writeFile(process.env.SWE_GATE_OUTPUT, JSON.stringify({ manifestSha256: MANIFEST_SHA256, batch: BATCH_TITLE,
    runId: process.env.GITHUB_RUN_ID, firstAttempt: true, priorPaidDispatches: 0,
    executionRequested: process.env.SWE_EXECUTE_REQUESTED === 'true' }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log('one-time paid batch gate passed; no model has been called')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
