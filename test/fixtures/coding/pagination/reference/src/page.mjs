export function paginate(items, page, pageSize) {
  const start = (page - 1) * pageSize
  return { items: items.slice(start, start + pageSize), totalPages: Math.ceil(items.length / pageSize) }
}
