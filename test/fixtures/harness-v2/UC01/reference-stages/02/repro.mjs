import assert from 'node:assert/strict'
import { decideSync } from './src/index.mjs'
assert.equal(decideSync({ localRev: '4', remoteRev: '4' }), 'noop')
assert.equal(decideSync({ localRev: '10', remoteRev: '9' }), 'push')
