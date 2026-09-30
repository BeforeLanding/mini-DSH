import assert from 'node:assert/strict'
import { normalizeName } from './src/name.mjs'
assert.equal(normalizeName('  Ada   Lovelace  '), 'ada lovelace')
console.log('public checks passed')
