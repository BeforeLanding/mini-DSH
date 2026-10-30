import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import { encryptFile, decryptFile } from './swe-evidence.mjs'

function keys() { return generateKeyPairSync('rsa', { modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } }) }

test('encrypted evidence round-trips locally while the public payload contains no raw trace', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'swe encrypted evidence '))
  try {
    const pair = keys(), input = path.join(directory, 'private.txt'), encrypted = path.join(directory, 'payload.enc'), output = path.join(directory, 'restored.txt')
    const body = 'SYNTHETIC_RAW_TRACE_MUST_NOT_BE_PUBLIC\n'.repeat(1000)
    await fs.writeFile(input, body)
    const meta = await encryptFile(input, pair.publicKey, encrypted, { manifestSha256: 'a'.repeat(64), sourceCommit: 'b'.repeat(40) })
    assert.equal((await fs.readFile(encrypted)).includes(Buffer.from('SYNTHETIC_RAW_TRACE')), false)
    assert.equal(JSON.stringify(meta).includes('SYNTHETIC_RAW_TRACE'), false)
    await decryptFile(encrypted, meta, pair.privateKey, output)
    assert.equal(await fs.readFile(output, 'utf8'), body)
    await assert.rejects(decryptFile(encrypted, meta, pair.privateKey, output), /EEXIST/)
    assert.equal(await fs.readFile(output, 'utf8'), body)
    await assert.rejects(encryptFile(input, pair.publicKey, encrypted, {}), /EEXIST/)
    const missingOutput = path.join(directory, 'missing.enc')
    await assert.rejects(encryptFile(path.join(directory, 'missing-input'), pair.publicKey, missingOutput, {}), /ENOENT/)
    assert.equal(await fs.stat(missingOutput).then(() => true, () => false), false)
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('wrong keys, changed ciphertext and changed batch context cannot leave an accepted plaintext output', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'swe evidence tamper '))
  try {
    const pair = keys(), other = keys(), input = path.join(directory, 'private.txt'), encrypted = path.join(directory, 'payload.enc')
    await fs.writeFile(input, 'synthetic evidence')
    const meta = await encryptFile(input, pair.publicKey, encrypted, { manifestSha256: 'a'.repeat(64) })
    const output = path.join(directory, 'must-not-exist.txt')
    await assert.rejects(decryptFile(encrypted, meta, other.privateKey, output))
    const context = structuredClone(meta)
    context.context.manifestSha256 = 'b'.repeat(64)
    await assert.rejects(decryptFile(encrypted, context, pair.privateKey, output))
    const bytes = await fs.readFile(encrypted)
    bytes[0] ^= 1
    await fs.writeFile(encrypted, bytes)
    await assert.rejects(decryptFile(encrypted, meta, pair.privateKey, output))
    assert.equal(await fs.stat(output).then(() => true, () => false), false)
    assert.ok((await fs.readdir(directory)).every(name => !name.includes('.partial-')))
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})
