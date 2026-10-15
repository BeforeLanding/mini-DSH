import { validatePage } from './validate.mjs'

export function pageSlice(items, page, size) {
  validatePage(page, size)
  const start = (page - 1) * size
  return items.slice(start, start + size)
}
