import { calculateSubtotal } from './pricing.mjs'
export function formatReceipt(items) {
  const { amount, currency } = calculateSubtotal(items)
  return `${currency} ${amount.toFixed(2)}`
}
