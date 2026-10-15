import assert from 'node:assert/strict'
import { createCart, addItem, removeItem, checkout } from './src/index.mjs'
const cart = createCart()
assert.ok(cart.state instanceof Map)
addItem(cart, 'a', 10, 2)
addItem(cart, 'a', 15, 2)
assert.equal(checkout(cart), 30)
removeItem(cart, 'a')
assert.equal(checkout(cart), 0)
