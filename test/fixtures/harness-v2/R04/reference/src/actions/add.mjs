import { put } from '../state/cart.mjs'
import { lineOf } from '../validate.mjs'
export const addItem = (cart, sku, priceCents, quantity) => put(cart.state, lineOf(sku, priceCents, quantity))
