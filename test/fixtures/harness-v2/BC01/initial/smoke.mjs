import assert from 'node:assert/strict'
import { groupEvents } from './src/index.mjs'
assert.deepEqual(groupEvents([{ at: '2024-01-01T12:00:00Z' }], 0), [{ day: '2024-01-01', count: 1 }])
