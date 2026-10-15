export const baseCents = items => items.reduce((sum, item) => sum + item.priceCents * item.quantity, 0)
