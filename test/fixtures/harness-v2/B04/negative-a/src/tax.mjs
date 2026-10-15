import { rateOf } from './rate.mjs'
import { rounded } from './round.mjs'
export const taxCents = (base, _net, region) => rounded(base * rateOf(region))
