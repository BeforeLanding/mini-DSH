import { calculateTotal } from './pricing.mjs'
export function renderReceipt(lines) { return `Total: $${(calculateTotal(lines) / 100).toFixed(2)}` }
