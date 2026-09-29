import assert from 'node:assert/strict'
import { clampIndex } from './src/index.mjs'
assert.equal(clampIndex(4, 4), 3)
assert.equal(clampIndex(0, 0), -1)
console.log('public checks passed')
