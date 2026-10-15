import { MAX_DOMESTIC_KG } from '../policy/domestic.mjs'
import { validPostcode } from './postcode.mjs'
import { validateCore } from './shared.mjs'
export function domesticReason(order) { return validateCore(order, MAX_DOMESTIC_KG) ?? (validPostcode(order.postcode) ? null : 'postcode') }
