import assert from 'node:assert/strict'
import { createCart, addItem, checkout } from './src/index.mjs'
const cart = createCart()
addItem(cart, 'a', 100, 2)
assert.equal(checkout(cart), 200)
