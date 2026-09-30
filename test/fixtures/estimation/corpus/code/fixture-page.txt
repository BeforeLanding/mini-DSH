export function paginate(items, page, pageSize) {
  const start = page * pageSize
  return { items: items.slice(start, start + pageSize), totalPages: Math.ceil(items.length / pageSize) }
}
