import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
assert.equal(spawnSync(process.execPath, ['repro.mjs'], { encoding: 'utf8' }).status, 1)
