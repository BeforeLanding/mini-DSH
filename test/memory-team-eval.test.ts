import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { prepareMemoryTeamManifests, validateMemoryTeamManifests } from '../scripts/eval-memory-team.js'
import type { MemoryTeamManifest } from '../scripts/eval-memory-team.js'
import { memoryHash } from '../src/core/memory-contracts.js'

function seal(manifest: MemoryTeamManifest) { const { digest: _digest, ...body } = manifest; return { ...body, digest: memoryHash(JSON.stringify(body)) } }
test('memory/team development protocol validates four actual Harness configurations with common data and budget and no model dispatch', async () => {
  const manifests = await prepareMemoryTeamManifests(), report = await validateMemoryTeamManifests(manifests)
  assert.equal(report.valid, true); assert.equal(report.providerCalls, 0); assert.equal(report.plannedDevelopmentEpisodes, 16)
  assert.ok(manifests.every(manifest => manifest.postCompactionPrune === false && !manifest.paidExecutionAuthorized && manifest.amountCapUsd === null))
  assert.deepEqual(manifests.map(manifest => [manifest.memory, manifest.team]), [[false, false], [true, false], [false, true], [true, true]])
})
test('development protocol rejects mismatched budgets, forged/stale provenance, duplicated arms and paid or formal claims', async () => {
  const manifests = await prepareMemoryTeamManifests()
  const mismatch = structuredClone(manifests); mismatch[1].taskGroupPolicy.maxTotalTokens++
  await assert.rejects(validateMemoryTeamManifests(mismatch), /total budget must match/)
  const paid = manifests.map(manifest => seal({ ...manifest, paidExecutionAuthorized: true as false }))
  await assert.rejects(validateMemoryTeamManifests(paid), /invalid, stale or paid/)
  const stale = manifests.map(manifest => seal({ ...manifest, source: { ...manifest.source, codeDigest: 'f'.repeat(64) } }))
  await assert.rejects(validateMemoryTeamManifests(stale), /invalid, stale or paid/)
  await assert.rejects(validateMemoryTeamManifests([manifests[0], manifests[0], manifests[2], manifests[3]]), /four independent/)
  const formal = manifests.map(manifest => seal({ ...manifest, phase: 'formal' as 'development' }))
  await assert.rejects(validateMemoryTeamManifests(formal), /invalid, stale or paid/)
})
test('memory/team evaluation executable refuses a live run rather than treating development validation as paid authorization', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/eval-memory-team.js', import.meta.url)), '--run', 'anything'], { encoding: 'utf8', windowsHide: true })
  assert.notEqual(result.status, 0); assert.match(result.stderr, /paid runs require a separate budget authorization/)
})
