import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const source = readFileSync('suite.mjs', 'utf8')
assert.match(source, /obsolete assertion awaiting cleanup/)
assert.match(source, /'review'\)/)
