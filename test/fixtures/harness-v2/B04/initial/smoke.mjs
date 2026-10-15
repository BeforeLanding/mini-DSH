import assert from 'node:assert/strict'
import { computeOrder } from './src/index.mjs'
assert.deepEqual(computeOrder({ items: [{ unitCents: 1000, quantity: 1 }] }), { netCents: 1000, taxCents: 100, totalCents: 1100 })
