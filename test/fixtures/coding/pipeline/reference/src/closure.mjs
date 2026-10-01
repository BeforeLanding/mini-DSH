// 传递依赖闭包：从 names 出发沿**本文件内声明过的**依赖可达的模块，含 names 自身。
// 外部名不是模块，走不到它、也不出现在结果里；names 里不是模块的名字直接忽略。
// 结果按模块首次出现顺序，天然去重；沿链走时用 reached 挡重复，环不会绕圈。
export function closure(records, names) {
  const declared = new Set(records.map(record => record.name))
  const deps = new Map(records.map(record => [record.name, record.deps.filter(dep => declared.has(dep))]))
  const reached = new Set()
  const stack = names.filter(name => declared.has(name))
  while (stack.length) {
    const name = stack.pop()
    if (reached.has(name)) continue
    reached.add(name)
    stack.push(...(deps.get(name) ?? []))
  }
  return records.filter(record => reached.has(record.name)).map(record => record.name)
}
