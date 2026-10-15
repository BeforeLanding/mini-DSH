import assert from 'node:assert/strict'
import { createLimiter } from './src/index.mjs'
const limiter = createLimiter(3)
assert.equal(limiter.take(1), true)
assert.equal(limiter.remaining(), 2)
