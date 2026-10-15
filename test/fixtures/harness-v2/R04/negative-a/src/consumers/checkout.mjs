import { lines } from '../state/cart.mjs'
export const checkout = cart => lines(cart.state).reduce((sum, line) => sum + line.priceCents, 0)
