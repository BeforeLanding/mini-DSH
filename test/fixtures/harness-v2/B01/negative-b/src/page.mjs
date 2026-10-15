import { validatePage } from './validate.mjs'
export function pageSlice(items, page, size) {
  validatePage(page, size)
  if (items.length === 0) throw new RangeError('no items')
  const start = (page - 1) * size
  return items.slice(start, start + size)
}
