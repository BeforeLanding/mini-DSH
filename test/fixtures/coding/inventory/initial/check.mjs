import assert from 'node:assert/strict'
import { calculateOrder } from './src/order.mjs'
import { formatOrder } from './src/receipt.mjs'
assert.deepEqual(calculateOrder([{ sku: 'a', quantity: 2 }, { sku: 'x', quantity: 1 }], { a: 3 }), { total: 6, missing: ['x'] })
console.log('public checks passed')
