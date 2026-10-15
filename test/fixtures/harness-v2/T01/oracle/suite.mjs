import assert from 'node:assert/strict'
import { classify } from './src/index.mjs'
assert.equal(classify(69), 'fail')
assert.equal(classify(70), 'pass')
assert.equal(classify(71), 'pass')
assert.throws(() => classify(-1), RangeError)
assert.throws(() => classify(100.5), RangeError)
