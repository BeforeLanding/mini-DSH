import assert from 'node:assert/strict'
import { decideSync } from './src/index.mjs'
assert.equal(decideSync({ localRev: '10', remoteRev: '9' }), 'push')
assert.equal(decideSync({ localRev: '12', remoteRev: '11', remoteDeleted: true }), 'delete')
