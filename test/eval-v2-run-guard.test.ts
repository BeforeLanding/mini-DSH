import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const runner = fileURLToPath(new URL('../scripts/eval-v2-run.js', import.meta.url))

test('paid V2 runner refuses invocation without explicit manifest, amount cap and execute flag', () => {
  const result = spawnSync(process.execPath, [runner], { encoding: 'utf8', timeout: 10_000 })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /--manifest FILE --evidence-root NEW_DIRECTORY --max-usd POSITIVE_NUMBER --execute/)
})

test('component runner rejects a mismatched protocol before any isolation or model work', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nx50-run-guard-'))
  try {
    const manifest = path.join(directory, 'manifest.json')
    fs.writeFileSync(manifest, JSON.stringify({ protocol: 'NX-45-dev-2arm-v1', split: 'component' }))
    const result = spawnSync(process.execPath, [runner, '--manifest', manifest, '--validate-only'], { encoding: 'utf8', timeout: 10_000 })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /protocol\/split mismatch/)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('component-loo runner accepts only its own protocol before any isolation or model work', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nx51-loo-run-guard-'))
  try {
    const manifest = path.join(directory, 'manifest.json')
    fs.writeFileSync(manifest, JSON.stringify({ protocol: 'NX-50-component-ab-v1', split: 'component-loo' }))
    const result = spawnSync(process.execPath, [runner, '--manifest', manifest, '--validate-only'], { encoding: 'utf8', timeout: 10_000 })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /protocol\/split mismatch/)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})
