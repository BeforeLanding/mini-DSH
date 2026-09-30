// 依赖在前。并列时每次从「依赖已经全部输出」的模块里取首次出现位置最靠前的一个，
// 这条规则决定 order 的逐项取值，不能换成别的遍历次序。
export function topoOrder(records, excluded = []) {
  const skip = new Set(excluded)
  const position = new Map(records.map((record, at) => [record.name, at]))
  const internal = new Map(records.map(record => [
    record.name,
    record.deps.filter(dep => position.has(dep) && !skip.has(dep)),
  ]))
  const pending = new Map(records
    .filter(record => !skip.has(record.name))
    .map(record => [record.name, internal.get(record.name).length]))
  const order = []
  while (true) {
    const ready = [...pending].filter(([, count]) => count === 0).map(([name]) => name)
    if (!ready.length) break
    ready.sort((a, b) => position.get(a) - position.get(b))
    const next = ready[0]
    order.push(next)
    pending.delete(next)
    for (const [name, count] of pending) if (internal.get(name).includes(next)) pending.set(name, count - 1)
  }
  return order
}
