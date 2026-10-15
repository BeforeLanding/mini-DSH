import { lines } from '../state/cart.mjs'
import { sorted } from '../format/sort.mjs'
export const summary = cart => sorted(lines(cart.state))
