import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { runDemo } from '../src/app/demo.js'

test('the packaged offline demo fixes the embedded project without a provider or network', async () => {
  const result = await runDemo({ quiet: true })
  try {
    assert.equal(result.passed, true)
    assert.match(result.output, /PASS: 2 \+ 3 = 5/)
    assert.ok(result.events.some(event => event.type === 'tool/result' && event.data.toolCallId === 'check-before' && event.data.isError))
    assert.ok(result.events.some(event => event.type === 'tool/result' && event.data.toolCallId === 'check-after' && !event.data.isError))
    assert.equal(await fs.readFile(path.join(result.workspace, 'calc.mjs'), 'utf8'), 'export function add(a, b) {\n  return a + b\n}\n')
  } finally { await fs.rm(path.dirname(result.workspace), { recursive: true, force: true }) }
})
