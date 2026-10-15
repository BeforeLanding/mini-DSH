export function validatePage(page, size) {
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(size) || size < 1) throw new RangeError('page and size must be positive integers')
}
