import assert from 'node:assert/strict'
import { computeOrder } from './src/index.mjs'
assert.equal(computeOrder({ items: [{ unitCents: 1000, quantity: 1 }], couponCents: 200 }).taxCents, 80)
