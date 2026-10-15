import { rateOf } from './rate.mjs'
import { rounded } from './round.mjs'
export const taxCents = (_base, net, region) => rounded(net * rateOf(region))
