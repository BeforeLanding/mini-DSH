import { lineTotal } from './pricing.mjs'
export function renderReceipt(lines) {
  let cents = 0
  for (const line of lines) cents += lineTotal(line)
  return `Total: $${(cents / 100).toFixed(2)}`
}
