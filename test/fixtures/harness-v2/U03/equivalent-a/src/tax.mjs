import { taxRate } from './tax-zone.mjs'
export function taxCents(_base, net, zone) { return Math.round(taxRate(zone) * net) }
