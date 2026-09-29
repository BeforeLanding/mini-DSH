export function calculateSubtotal(items) {
  const amount = items.reduce((sum, item) => sum + item.price * item.quantity, 0)
  return { amount, currency: 'CNY' }
}
