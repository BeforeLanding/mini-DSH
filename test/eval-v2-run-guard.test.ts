import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const runner = fileURLToPath(new URL('../scripts/eval-v2-run.js', import.meta.url))

test('paid V2 runner refuses invocation without explicit manifest, amount cap and execute flag', () => {
  const result = spawnSync(process.execPath, [runner], { encoding: 'utf8', timeout: 10_000 })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /--manifest FILE --evidence-root NEW_DIRECTORY --max-usd POSITIVE_NUMBER --execute/)
})
