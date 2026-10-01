// 第 9 节的两类「排不出来」按优先级判定：环成员 > 依赖环成员。一个模块可能同时命中两条，
// 判定顺序写死在规格里，不能由实现的遍历次序决定。
// 只有这两类：外部名不阻挡排序（第 2 节「外部依赖不参与构建顺序」，`tool: util ghost` 里的 tool
// 照常排进 order），所以「依赖链里有外部名」不是一种阻塞原因。
// 判定要沿依赖链传递：依赖一个「依赖环成员的模块」同样排不出来。沿链走时用 visited 挡重复，
// 环成员在递归进去之前就被 hit 拦下，因此不会走进去绕圈。
const reachable = (start, edges, hit) => {
  const visited = new Set([start])
  const stack = [...edges(start)]
  while (stack.length) {
    const next = stack.pop()
    if (hit(next)) return true
    if (visited.has(next)) continue
    visited.add(next)
    stack.push(...edges(next))
  }
  return false
}

export function blockReasons(records, cycles) {
  const declared = new Set(records.map(record => record.name))
  const deps = new Map(records.map(record => [record.name, record.deps]))
  const members = new Set(cycles.flat())
  // 只看本文件内声明过的依赖：外部名既不参与排序也不构成依赖边。
  const inFile = name => (deps.get(name) ?? []).filter(dep => declared.has(dep))
  const hitsMember = name => reachable(name, inFile, dep => members.has(dep))
  return records.flatMap(record => {
    const reason = members.has(record.name) ? 'cycle' : hitsMember(record.name) ? 'depends-on-cycle' : undefined
    return reason === undefined ? [] : [{ name: record.name, reason }]
  })
}
