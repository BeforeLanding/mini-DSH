import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const { normalizeName } = await import(pathToFileURL(path.join(process.argv[2], 'src/name.mjs')).href)
for (const [input, expected] of [['  Ada   Lovelace  ', 'ada lovelace'], ['A\t B\nC', 'a b c'], ['  ', ''], ['MiXeD', 'mixed']]) assert.equal(normalizeName(input), expected)
console.log('acceptance passed: normalize')
