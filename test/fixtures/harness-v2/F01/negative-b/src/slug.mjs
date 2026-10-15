import { normalizeWords } from './normalize.mjs'
export function slugify(input, options = {}) {
  const separator = options.separator ?? '_'
  if (separator !== '-' && separator !== '_') throw new RangeError('bad separator')
  return normalizeWords(input).replaceAll(' ', separator)
}
