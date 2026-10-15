import { MIN, MAX, PASS } from './limits.mjs'
export function classify(score) {
  if (!Number.isInteger(score) || score < MIN || score > MAX) throw new RangeError('score must be an integer in 0..100')
  return score > PASS ? 'pass' : 'fail'
}
