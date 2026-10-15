import { taxRate } from './tax-zone.mjs'
import { cents } from './round.mjs'
export const taxCents = (_base, net, zone) => cents(net * taxRate(zone))
