import assert from 'node:assert/strict'
import { collectAlerts } from './src/index.mjs'
assert.deepEqual(collectAlerts([{ tenant: 'a', id: 'x', at: 1, severity: 'low' }]), [{ tenant: 'a', id: 'x', at: 1, severity: 'low' }])
