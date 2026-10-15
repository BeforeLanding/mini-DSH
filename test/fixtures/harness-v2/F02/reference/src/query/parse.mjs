export function parseQuery(query = {}) {
  const filter = {}
  if (query.status !== undefined) {
    if (query.status !== 'open' && query.status !== 'closed') throw new RangeError('status must be open or closed')
    filter.status = query.status
  }
  if (query.minTotal !== undefined) {
    if (!Number.isInteger(query.minTotal) || query.minTotal < 0) throw new RangeError('minTotal must be nonnegative integer')
    filter.minTotal = query.minTotal
  }
  return filter
}
