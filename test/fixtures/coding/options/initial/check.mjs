import assert from 'node:assert/strict'
import { joinWords } from './src/join.mjs'
assert.equal(joinWords(['a', 'b'], { separator: '/' }), 'a/b')
assert.equal(joinWords(['a', '', 'b'], { skipEmpty: true }), 'a, b')
console.log('public checks passed')
