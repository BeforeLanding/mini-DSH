import { MAX_DOMESTIC_KG } from '../policy/domestic.mjs'
import { MAX_LONGEST_CM } from '../policy/dimensions.mjs'
import { validPostcode } from './postcode.mjs'
export function domesticReason(order) {
  if (!(order.weightKg > 0 && order.weightKg <= MAX_DOMESTIC_KG)) return 'weight'
  if (!(order.longestCm > 0 && order.longestCm <= MAX_LONGEST_CM)) return 'dimensions'
  if (!validPostcode(order.postcode)) return 'postcode'
  return null
}
