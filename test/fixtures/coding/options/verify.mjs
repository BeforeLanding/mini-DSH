import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const { joinWords } = await import(pathToFileURL(path.join(process.argv[2], 'src/join.mjs')).href)
const words = ['a', '', 'b'], before = [...words]
assert.equal(joinWords(words), 'a, , b')
assert.equal(joinWords(words, {}), 'a, , b')
assert.equal(joinWords(words, { separator: '|' }), 'a||b')
assert.equal(joinWords(words, { skipEmpty: true }), 'a, b')
assert.equal(joinWords(words, { separator: '', skipEmpty: true }), 'ab')
assert.equal(joinWords(['', ' ', 'x'], { separator: '/', skipEmpty: true }), ' /x')
assert.equal(joinWords([], { skipEmpty: true }), '')
assert.equal(joinWords(['only']), 'only')
assert.deepEqual(words, before)
console.log('acceptance passed: options')
