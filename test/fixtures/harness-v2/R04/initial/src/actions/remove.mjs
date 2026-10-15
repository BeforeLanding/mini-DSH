import { drop } from '../state/legacy.mjs'
export const removeItem = (cart, sku) => drop(cart.state, sku)
