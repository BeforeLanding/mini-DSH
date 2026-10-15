import { MAX_INTERNATIONAL_KG } from '../policy/international.mjs'
import { validCustoms } from './customs.mjs'
import { validateCore } from './shared.mjs'
export function internationalReason(order) { return validateCore(order, MAX_INTERNATIONAL_KG) ?? (validCustoms(order.customsCode) ? null : 'customs') }
