import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { createVerifier } from './src/index.mjs'
const sign = (id, at) => createHmac('sha256', 'secret').update(`${id}:${at}`).digest('hex')
const verifier = createVerifier('secret', 1_000_000)
const valid = { id: 'A', at: 1_000_000, signature: sign('A', 1_000_000) }
assert.equal(verifier.verify(valid), true)
assert.equal(verifier.verify(valid), false)
assert.equal(verifier.verify({ id: 'B', at: 1_400_000, signature: sign('B', 1_400_000) }), false)
assert.equal(verifier.verify({ id: 'C', at: 1_000_000, signature: '0'.repeat(64) }), false)
assert.equal(verifier.verify({ id: 'B', at: 1_000_000, signature: sign('B', 1_000_000) }), true)
