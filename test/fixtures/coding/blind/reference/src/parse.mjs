const NAME = /^[A-Za-z0-9_-]+$/

const failure = (line, detail) => new Error(`line ${line}: ${detail}`)

export function parseDeps(text) {
  const order = []
  const deps = new Map()
  const lines = String(text).split('\n')
  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at].trim()
    if (!line || line.startsWith('#')) continue
    const colon = line.indexOf(':')
    if (colon < 0) throw failure(at + 1, "missing ':'")
    const name = line.slice(0, colon).trim()
    if (!NAME.test(name)) throw failure(at + 1, 'invalid module name')
    const tail = line.slice(colon + 1).trim()
    const declared = tail ? tail.split(/\s+/) : []
    for (const dep of declared) if (!NAME.test(dep)) throw failure(at + 1, 'invalid dependency name')
    // 同一模块再次声明时合并，不是覆盖。
    if (!deps.has(name)) {
      deps.set(name, [])
      order.push(name)
    }
    for (const dep of declared) if (!deps.get(name).includes(dep)) deps.get(name).push(dep)
  }
  const modules = new Set(order)
  const external = []
  for (const name of order) for (const dep of deps.get(name)) if (!modules.has(dep) && !external.includes(dep)) external.push(dep)
  return { records: order.map(name => ({ name, deps: [...deps.get(name)] })), external }
}
