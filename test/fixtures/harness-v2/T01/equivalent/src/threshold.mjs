import { MIN, MAX, PASS } from './limits.mjs'
export function classify(score) {
  if (typeof score !== 'number' || !Number.isInteger(score) || score < MIN || score > MAX) throw new RangeError('score must be an integer in 0..100')
  if (score < PASS) return 'fail'
  return 'pass'
}
