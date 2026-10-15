import assert from 'node:assert/strict'
import { createLimiter } from './src/index.mjs'
const a = createLimiter(3), b = createLimiter(3)
assert.equal(a.take(2), true)
assert.equal(a.take(2), false)
assert.equal(a.remaining(), 1)
assert.equal(b.remaining(), 3)
assert.throws(() => a.take(0), RangeError)
a.reset()
assert.equal(a.remaining(), 3)
assert.equal(a.take(3), true)
assert.equal(a.remaining(), 0)
