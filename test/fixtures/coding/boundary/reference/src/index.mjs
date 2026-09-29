export function clampIndex(index, length) {
  if (length === 0) return -1
  return Math.max(0, Math.min(Math.trunc(index), length - 1))
}
