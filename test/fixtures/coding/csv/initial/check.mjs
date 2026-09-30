import assert from 'node:assert/strict'
import { parseCsvLine } from './src/csv.mjs'
assert.deepEqual(parseCsvLine('a,"b,c",d'), ['a', 'b,c', 'd'])
console.log('public checks passed')
