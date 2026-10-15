import { lines } from '../state/cart.mjs'
import { lineMoney } from '../format/money.mjs'
export const checkout = cart => lines(cart.state).reduce((sum, line) => sum + lineMoney(line), 0)
