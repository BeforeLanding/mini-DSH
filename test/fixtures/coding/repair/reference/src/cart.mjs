export function subtotal(items) {
  return items.reduce((sum, item) => sum + item.price * item.quantity * (1 - (item.discount ?? 0)), 0)
}

export function discount(amount, percentOff) {
  return Math.round(amount * (1 - percentOff / 100) * 100) / 100
}

export function total(items, percentOff) {
  return discount(subtotal(items), percentOff)
}
