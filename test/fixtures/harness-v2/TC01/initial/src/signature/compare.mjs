import { timingSafeEqual } from 'node:crypto'
export function equalSignature(left, right) {
  if (typeof right !== 'string' || !/^[0-9a-f]{64}$/.test(right)) return false
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}
