import { taxRate } from './tax-zone.mjs'
import { cents } from './round.mjs'
export const taxCents = (base, _net, zone) => cents(base * taxRate(zone))
