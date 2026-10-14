// 按顺序取条目，直到再加一条就会超过上限。完整规则见 docs/SPEC.md。
export function takeWithin(entries, limit) {
  if (!Array.isArray(entries)) throw new Error('entries must be an array')
  if (!Number.isFinite(limit) || limit < 0) throw new Error('limit must be a non-negative finite number')
  const ids = []
  let total = 0
  for (const entry of entries) {
    if (!entry || typeof entry.id !== 'string' || entry.id === '') throw new Error('each entry needs a non-empty string id')
    if (!Number.isFinite(entry.amount) || entry.amount < 0) throw new Error('each entry needs a non-negative finite amount')
    if (total + entry.amount > limit) break
    total = entry.amount
    ids.push(entry.id)
  }
  return { ids, total }
}
