import { normalizeWords } from './normalize.mjs'
export function slugify(input, options = {}) {
  const separator = options.separator ?? '-'
  if (separator !== '-' && separator !== '_') throw new RangeError('separator must be - or _')
  return normalizeWords(input).replaceAll(' ', separator)
}
