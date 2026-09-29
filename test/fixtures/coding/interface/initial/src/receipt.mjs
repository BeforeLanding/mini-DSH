import { calculateSubtotal } from './pricing.mjs'
export function formatReceipt(items) {
  return calculateSubtotal(items).toFixed(2)
}
