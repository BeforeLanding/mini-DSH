// 批号 = 本文件内所有依赖的最大批号 + 1；没有内部依赖则为 0。批内沿用 order 的相对次序，
// 因此按 order 扫一遍就能定下来。
export function toBatches(order, records) {
  const position = new Map(order.map((name, at) => [name, at]))
  const internal = new Map(records.map(record => [
    record.name,
    record.deps.filter(dep => position.has(dep)),
  ]))
  const layer = new Map()
  const batches = []
  for (const name of order) {
    const layers = internal.get(name).map(dep => layer.get(dep))
    const at = layers.length ? Math.max(...layers) + 1 : 0
    layer.set(name, at)
    while (batches.length <= at) batches.push([])
    batches[at].push(name)
  }
  return batches
}
