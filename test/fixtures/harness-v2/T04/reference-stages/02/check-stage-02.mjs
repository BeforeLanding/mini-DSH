import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
assert.equal(spawnSync(process.execPath, ['suite.mjs'], { encoding: 'utf8' }).status, 1)
