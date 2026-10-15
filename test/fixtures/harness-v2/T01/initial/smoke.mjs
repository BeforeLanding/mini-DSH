import assert from 'node:assert/strict'
import { classify } from './src/index.mjs'
assert.equal(classify(80), 'pass')
assert.equal(classify(40), 'fail')
