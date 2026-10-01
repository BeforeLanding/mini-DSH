export function subtotal(items) {
  return items.reduce((sum, item) => sum + item.price * item.quantity, 0)
}

export function discount(amount, percentOff) {
  return amount - amount * percentOff
}

export function total(items, percentOff) {
  return discount(subtotal(items), percentOff)
}
