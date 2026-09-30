import assert from 'node:assert/strict'
import { buildQuery } from './src/query.mjs'
assert.equal(buildQuery({ b: 'a b', a: 1 }), 'a=1&b=a%20b')
console.log('public checks passed')
