import { validateLimit, validateAmount } from './validate.mjs'
export function createLimiter(limit) {
  validateLimit(limit)
  let consumed = 0
  return {
    take(amount) { validateAmount(amount); if (consumed + amount > limit) return false; consumed += amount; return true },
    remaining() { return limit - consumed }, reset() { consumed = 0 },
  }
}
