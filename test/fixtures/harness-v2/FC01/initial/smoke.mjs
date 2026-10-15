import assert from 'node:assert/strict'
import { isEnabled } from './src/index.mjs'
assert.equal(isEnabled('a', { flags: { a: true } }), true)
