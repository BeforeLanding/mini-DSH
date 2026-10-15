import { put } from '../state/legacy.mjs'
import { lineOf } from '../validate.mjs'
export const addItem = (cart, sku, priceCents, quantity) => put(cart.state, lineOf(sku, priceCents, quantity))
