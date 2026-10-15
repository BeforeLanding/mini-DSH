import { normalize } from './input.mjs'
import { requestId } from './identity.mjs'
import { baseCents } from './items.mjs'
import { discountCents } from './coupon.mjs'
import { shippingCents } from './shipping.mjs'
import { netCents } from './subtotal.mjs'
import { taxCents } from './tax.mjs'
import { totalCents } from './total.mjs'
import { response } from './response.mjs'
export function computeInvoice(raw) {
  const input = normalize(raw)
  const base = baseCents(input.items)
  const net = netCents(base, discountCents(base, input.couponCents))
  const tax = taxCents(base, net, input.zone)
  const shipping = shippingCents(input)
  return response(requestId(input), net, tax, shipping, totalCents(net, tax, shipping))
}
