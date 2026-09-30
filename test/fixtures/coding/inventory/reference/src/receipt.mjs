import { calculateOrder } from './order.mjs'
export function formatOrder(lines, catalog) {
  const { total, missing } = calculateOrder(lines, catalog)
  return `Total: ${total.toFixed(2)}; missing: ${missing.join(',') || 'none'}`
}
