import { validatePage } from './validate.mjs'
export function pageSlice(items, page, size) {
  validatePage(page, size)
  if (page > 1) return items.slice((page - 1) * size + 1, page * size + 1)
  return items.slice(0, size)
}
