export function normalizeName(value) {
  return value.trim().replace(/\s+/g, ' ').toLowerCase()
}
