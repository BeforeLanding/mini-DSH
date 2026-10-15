import assert from 'node:assert/strict'
import { decideSync } from './src/index.mjs'
assert.equal(decideSync({ localRev: '1', remoteRev: '2' }), 'pull')
assert.equal(decideSync({ localRev: '4', remoteRev: '4' }), 'noop')
