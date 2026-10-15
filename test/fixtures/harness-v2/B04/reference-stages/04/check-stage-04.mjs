import assert from 'node:assert/strict'
import { computeOrder } from './src/index.mjs'
assert.deepEqual(computeOrder({ items: [{ unitCents: 1000, quantity: 1 }], couponCents: 200, refundCents: -250, region: 'B' }), { netCents: 800, taxCents: 40, totalCents: 590 })
