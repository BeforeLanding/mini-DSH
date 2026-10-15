export const normalize = raw => ({ items: raw.items ?? [], couponCents: raw.couponCents ?? 0, refundCents: raw.refundCents ?? 0, region: raw.region ?? 'A' })
