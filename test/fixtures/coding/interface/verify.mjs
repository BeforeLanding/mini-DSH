import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const load = name => import(pathToFileURL(path.join(process.argv[2], 'src', name)).href)
const { calculateSubtotal } = await load('pricing.mjs')
const { formatReceipt } = await load('receipt.mjs')
for (const items of [[], [{ price: 6.25, quantity: 2 }], [{ price: 3, quantity: 4 }, { price: 0.5, quantity: 3 }], [{ price: 10, quantity: 0 }]]) {
  const before = structuredClone(items)
  const amount = items.reduce((sum, item) => sum + item.price * item.quantity, 0)
  assert.deepEqual(calculateSubtotal(items), { amount, currency: 'CNY' })
  assert.equal(formatReceipt(items), `CNY ${amount.toFixed(2)}`)
  assert.deepEqual(items, before)
}
console.log('acceptance passed: interface')
