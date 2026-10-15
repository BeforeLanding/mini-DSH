import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { createVerifier } from './src/index.mjs'
const signature = createHmac('sha256', 'k').update('a:1000').digest('hex')
assert.equal(createVerifier('k', 1000).verify({ id: 'a', at: 1000, signature }), true)
