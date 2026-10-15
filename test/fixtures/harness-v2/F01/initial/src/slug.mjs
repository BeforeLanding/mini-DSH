import { normalizeWords } from './normalize.mjs'
export function slugify(input) { return normalizeWords(input).replaceAll(' ', '-') }
