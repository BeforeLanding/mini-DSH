import { lines } from '../state/cart.mjs'
import { lineCount } from '../format/count.mjs'
export const badge = cart => lines(cart.state).reduce((sum, line) => sum + lineCount(line), 0)
