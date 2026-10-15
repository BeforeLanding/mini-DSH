import { lines } from '../state/legacy.mjs'
import { lineMoney } from '../format/money.mjs'
export const checkout = cart => lines(cart.state).reduce((sum, line) => sum + lineMoney(line), 0)
