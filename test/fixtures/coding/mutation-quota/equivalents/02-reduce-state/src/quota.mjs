// 行为保持的等价实现：把校验抽成一个辅助函数，主循环改成一次 reduce，把「已经越限」记在状态里。
export function takeWithin(entries, limit) {
  if (!Array.isArray(entries)) throw new Error('entries must be an array')
  if (!Number.isFinite(limit) || limit < 0) throw new Error('limit must be a non-negative finite number')
  const taken = entries.reduce((state, entry) => {
    if (state.done) return state
    assertUsable(entry)
    if (state.total + entry.amount > limit) return { ids: state.ids, total: state.total, done: true }
    return { ids: [...state.ids, entry.id], total: state.total + entry.amount, done: false }
  }, { ids: [], total: 0, done: false })
  return { ids: taken.ids, total: taken.total }
}

function assertUsable(entry) {
  if (!entry || typeof entry.id !== 'string' || entry.id === '') throw new Error('each entry needs a non-empty string id')
  if (!Number.isFinite(entry.amount) || entry.amount < 0) throw new Error('each entry needs a non-negative finite amount')
}
