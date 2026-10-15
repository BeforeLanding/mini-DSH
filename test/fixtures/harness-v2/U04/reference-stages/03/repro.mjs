import assert from 'node:assert/strict'
import { canAccess } from './src/index.mjs'
const base = { role: 'staff', resource: 'internal', action: 'export', region: 'EU' }
assert.equal(canAccess(base), false)
assert.equal(canAccess({ ...base, legacyToken: true }), true)
