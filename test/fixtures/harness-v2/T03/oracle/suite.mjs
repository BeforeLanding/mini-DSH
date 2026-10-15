import assert from 'node:assert/strict'
import { collectAlerts } from './src/index.mjs'
const events = [
  { tenant: 'north', id: '7', at: 1, severity: 'high' },
  { tenant: 'south', id: '7', at: 5, severity: 'medium' },
  { tenant: 'north', id: '7', at: 4, severity: 'low' },
  { tenant: 'south', id: '7', at: 5, severity: 'high' },
]
assert.deepEqual(collectAlerts(events), [
  { tenant: 'north', id: '7', at: 4, severity: 'low' },
  { tenant: 'south', id: '7', at: 5, severity: 'high' },
])
assert.deepEqual(collectAlerts([]), [])
