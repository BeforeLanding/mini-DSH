import { validateLimit, validateAmount } from './validate.mjs'
import { stateFor } from './state.mjs'
export function createLimiter(limit) {
  validateLimit(limit)
  const state = stateFor(limit)
  return {
    take(amount) { validateAmount(amount); if (amount > state.remaining) return false; state.remaining -= amount; return true },
    remaining() { return state.remaining }, reset() {},
  }
}
