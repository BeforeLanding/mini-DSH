export const normalize = input => ({ id: String(input.id), items: input.items ?? [], couponCents: input.couponCents ?? 0, shippingCents: input.shippingCents ?? 0, zone: input.zone ?? 'A' })
