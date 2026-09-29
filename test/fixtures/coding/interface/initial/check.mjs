import assert from 'node:assert/strict'
import { calculateSubtotal } from './src/pricing.mjs'
import { formatReceipt } from './src/receipt.mjs'
assert.deepEqual(calculateSubtotal([]), { amount: 0, currency: 'CNY' })
assert.equal(formatReceipt([{ price: 6.25, quantity: 2 }]), 'CNY 12.50')
console.log('public checks passed')
