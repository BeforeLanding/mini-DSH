import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateKeyPairSync } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { decryptFile } from './swe-evidence.mjs'

test('public artifacts contain aggregates only; private traces are encrypted and workspaces excluded', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swe artifact scope '))
  try {
    const inputs = path.join(root, 'inputs'), evidence = path.join(root, 'evidence'), output = path.join(root, 'public')
    await fs.mkdir(inputs)
    const episode = path.join(evidence, 'episodes', 'demo', 'full')
    await fs.mkdir(path.join(episode, 'workspace'), { recursive: true })
    await fs.writeFile(path.join(episode, 'events.jsonl'), 'SYNTHETIC_PRIVATE_TRACE\n')
    await fs.writeFile(path.join(episode, 'workspace', 'large.txt'), 'WORKSPACE_MUST_NOT_BE_ARCHIVED')
    await fs.writeFile(path.join(inputs, 'input-metadata.json'), JSON.stringify({ plannedEpisodes: 30, paidRequests: 0 }))
    await fs.writeFile(path.join(evidence, 'report.json'), JSON.stringify({ plannedEpisodes: 30, executedEpisodes: 1, batch: {},
      perArm: [{ armId: 'full', planned: 5, executed: 1, resolvedOverPlanned: 1, extraPrompt: 'SYNTHETIC_PRIVATE_TRACE' }],
      paired: [], componentComparisons: [], scoring: {}, failureTraces: [{ error: 'SYNTHETIC_PRIVATE_TRACE' }] }))
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } })
    const publicKey = path.join(root, 'public.pem')
    await fs.writeFile(publicKey, pair.publicKey)
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./swe-development-artifact.mjs', import.meta.url))], {
      encoding: 'utf8', env: { ...process.env, SWE_INPUT_ROOT: inputs, SWE_EVIDENCE_ROOT: evidence, SWE_PUBLIC_ROOT: output,
        SWE_EVIDENCE_PUBLIC_KEY: publicKey, SWE_EXPECTED_SHA256: 'a'.repeat(64), GITHUB_RUN_ID: 'synthetic', GITHUB_SHA: 'b'.repeat(40) },
    })
    assert.equal(result.status, 0, result.stderr)
    const summary = await fs.readFile(path.join(output, 'summary.json'), 'utf8')
    assert.equal(summary.includes('SYNTHETIC_PRIVATE_TRACE'), false)
    const cipher = path.join(output, 'raw-evidence.tar.gz.enc')
    const metadata = JSON.parse(await fs.readFile(cipher + '.json', 'utf8'))
    const archive = path.join(root, 'restored.tar.gz')
    await decryptFile(cipher, metadata, pair.privateKey, archive)
    const listing = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' })
    assert.equal(listing.status, 0, listing.stderr)
    assert.ok(listing.stdout.includes('events.jsonl'))
    assert.equal(listing.stdout.includes('workspace'), false)
    assert.equal(await fs.stat(path.join(root, 'swe-raw-private.tar.gz')).then(() => true, () => false), false)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
