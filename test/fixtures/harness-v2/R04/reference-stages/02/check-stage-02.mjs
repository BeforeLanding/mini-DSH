import assert from 'node:assert/strict'
import { createCart, addItem, checkout, badge, summary } from './src/index.mjs'
const cart = createCart()
assert.ok(Array.isArray(cart.state))
addItem(cart, 'a', 10, 2)
assert.equal(checkout(cart), 20)
assert.equal(badge(cart), 2)
assert.deepEqual(summary(cart), [{ sku: 'a', priceCents: 10, quantity: 2 }])
