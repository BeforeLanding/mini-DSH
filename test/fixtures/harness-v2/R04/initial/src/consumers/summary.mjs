import { lines } from '../state/legacy.mjs'
import { sorted } from '../format/sort.mjs'
export const summary = cart => sorted(lines(cart.state))
