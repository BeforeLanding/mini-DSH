// 行为保持的等价实现：改成带下标的 while 循环，用 `running` 标志代替 `break`，
// 并把「装得下」表达成一个 <= 判断（原实现是它的否定 > 配上 break）。
export function takeWithin(entries, limit) {
  if (!Array.isArray(entries)) throw new Error('entries must be an array')
  if (!Number.isFinite(limit) || limit < 0) throw new Error('limit must be a non-negative finite number')
  const ids = []
  let total = 0
  let index = 0
  let running = true
  while (running && index < entries.length) {
    const entry = entries[index]
    if (!entry || typeof entry.id !== 'string' || entry.id === '') throw new Error('each entry needs a non-empty string id')
    if (!Number.isFinite(entry.amount) || entry.amount < 0) throw new Error('each entry needs a non-negative finite amount')
    running = total + entry.amount <= limit
    if (running) {
      total += entry.amount
      ids.push(entry.id)
    }
    index += 1
  }
  return { ids, total }
}
