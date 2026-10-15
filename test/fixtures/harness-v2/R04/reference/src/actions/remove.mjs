import { drop } from '../state/cart.mjs'
export const removeItem = (cart, sku) => drop(cart.state, sku)
