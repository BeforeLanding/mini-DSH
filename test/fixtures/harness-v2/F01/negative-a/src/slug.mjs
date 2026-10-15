import { normalizeWords } from './normalize.mjs'
export function slugify(input, options = {}) {
  if (options.separator && options.separator !== '_') throw new RangeError('bad separator')
  return normalizeWords(input).replaceAll(' ', '-')
}
