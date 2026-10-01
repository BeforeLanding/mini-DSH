// Tarjan 强连通分量：成员数大于 1 的分量，或真正的自环，才算环。
export function findCycles(records) {
  const names = records.map(record => record.name)
  const position = new Map(names.map((name, at) => [name, at]))
  const edges = new Map(records.map(record => [record.name, record.deps.filter(dep => position.has(dep))]))
  const index = new Map()
  const low = new Map()
  const onStack = new Set()
  const stack = []
  const cycles = []
  let counter = 0
  const visit = name => {
    index.set(name, counter)
    low.set(name, counter)
    counter += 1
    stack.push(name)
    onStack.add(name)
    for (const dep of edges.get(name)) {
      if (!index.has(dep)) {
        visit(dep)
        low.set(name, Math.min(low.get(name), low.get(dep)))
      } else if (onStack.has(dep)) low.set(name, Math.min(low.get(name), index.get(dep)))
    }
    if (low.get(name) !== index.get(name)) return
    const members = []
    while (true) {
      const member = stack.pop()
      onStack.delete(member)
      members.push(member)
      if (member === name) break
    }
    const selfLoop = members.length === 1 && edges.get(members[0]).includes(members[0])
    if (members.length > 1 || selfLoop) cycles.push(members.sort((a, b) => position.get(a) - position.get(b)))
  }
  for (const name of names) if (!index.has(name)) visit(name)
  return cycles.sort((a, b) => position.get(a[0]) - position.get(b[0]))
}
