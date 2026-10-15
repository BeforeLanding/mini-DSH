import { normalize } from './input.mjs'
import { baseCents } from './base.mjs'
import { couponApplied } from './coupon.mjs'
import { netCents } from './net.mjs'
import { taxCents } from './tax.mjs'
import { refundCents } from './refund.mjs'
import { totalCents } from './total.mjs'
import { response } from './response.mjs'
export function computeOrder(raw) {
  const input = normalize(raw), base = baseCents(input.items), net = netCents(base, couponApplied(base, input.couponCents))
  const tax = taxCents(base, net, input.region)
  return response(net, tax, totalCents(net, tax, refundCents(input)))
}
