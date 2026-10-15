export const normalize = raw => ({ amountCents: Number(raw.amountCents), vip: raw.vip === true })
