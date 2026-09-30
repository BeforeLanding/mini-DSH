import { calculateOrder } from './order.mjs'
export function formatOrder(lines, catalog) {
  return `Total: ${calculateOrder(lines, catalog).toFixed(2)}`
}
