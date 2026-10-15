import { marketName } from '../format/market.mjs'
import { valid, invalid } from '../format/result.mjs'
import { domesticReason } from '../rules/domestic.mjs'
import { internationalReason } from '../rules/international.mjs'
export function validateShipment(order, market) {
  const name = marketName(market)
  const reason = name === 'domestic' ? domesticReason(order) : name === 'international' ? internationalReason(order) : 'market'
  return reason === null ? valid() : invalid(reason)
}
