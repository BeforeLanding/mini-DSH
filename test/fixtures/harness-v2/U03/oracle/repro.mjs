import assert from 'node:assert/strict'
import { computeInvoice } from './src/index.mjs'
for (const [id, zone, expectedTax] of [['alpha', 'A', 80], ['beta', 'B', 40]]) {
  const actual = computeInvoice({ id, zone, items: [{ priceCents: 1000, quantity: 1 }], couponCents: 200, shippingCents: 100 })
  assert.equal(actual.taxCents, expectedTax)
  assert.equal(actual.totalCents, 800 + expectedTax + 100)
}
