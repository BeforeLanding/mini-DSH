import { MAX_INTERNATIONAL_KG } from '../policy/international.mjs'
import { MAX_LONGEST_CM } from '../policy/dimensions.mjs'
import { validCustoms } from './customs.mjs'
export function internationalReason(order) {
  if (!(order.weightKg > 0 && order.weightKg <= MAX_INTERNATIONAL_KG)) return 'weight'
  if (!(order.longestCm > 0 && order.longestCm <= MAX_LONGEST_CM)) return 'dimensions'
  if (!validCustoms(order.customsCode)) return 'customs'
  return null
}
