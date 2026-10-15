import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createCart, addItem, checkout } from './src/index.mjs'
const cart = createCart()
addItem(cart, 'a', 10, 1)
assert.equal(checkout(cart), 10)
for (const name of ['api/cart', 'actions/add', 'actions/remove', 'consumers/checkout', 'consumers/badge', 'consumers/summary', 'state/cart']) assert.doesNotMatch(readFileSync(`src/${name}.mjs`, 'utf8'), /legacy\.mjs/)
