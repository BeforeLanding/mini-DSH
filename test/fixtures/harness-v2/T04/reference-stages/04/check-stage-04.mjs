import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
assert.doesNotMatch(readFileSync('suite.mjs', 'utf8'), /obsolete assertion awaiting cleanup/)
assert.equal(spawnSync(process.execPath, ['suite.mjs'], { encoding: 'utf8' }).status, 1)
