import { MAX_LONGEST_CM } from '../policy/dimensions.mjs'
export function validateCore(order, _maxWeight) {
  if (!(order.weightKg > 0 && order.weightKg <= 20)) return 'weight'
  if (!(order.longestCm > 0 && order.longestCm <= MAX_LONGEST_CM)) return 'dimensions'
  return null
}
