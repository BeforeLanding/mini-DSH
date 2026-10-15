import assert from 'node:assert/strict'
import { canAccess } from './src/index.mjs'
assert.equal(canAccess({ role: 'guest', resource: 'public', action: 'read' }), true)
assert.equal(canAccess({ role: 'staff', resource: 'internal', action: 'read' }), true)
assert.equal(canAccess({ role: 'admin', resource: 'internal', action: 'export' }), true)
