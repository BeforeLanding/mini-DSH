import assert from 'node:assert/strict'
import { newState, put, drop, lines } from './src/state/cart.mjs'
const state = newState()
put(state, { sku: 'a', priceCents: 10, quantity: 1 })
assert.deepEqual(lines(state), [{ sku: 'a', priceCents: 10, quantity: 1 }])
drop(state, 'a')
assert.deepEqual(lines(state), [])
