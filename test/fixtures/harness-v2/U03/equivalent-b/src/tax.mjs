import { cents } from './round.mjs'
export const taxCents = (_base, net, zone) => cents(net * (zone === 'B' ? 5 : 10) / 100)
