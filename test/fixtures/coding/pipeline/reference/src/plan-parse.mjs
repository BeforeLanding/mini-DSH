// 第 4 节的渲染逐字固定，因此反向解析可以按段落头严格推进：五段必须齐全、按 source → order →
// batches → external → cycles 的顺序出现，任何一处不符都带行号报错。
// 缩进行只归属它所在的段落——cycles 的成员行与 batches 的批次行长得完全一样，只能靠段落归属区分，
// 这也是第 5 节反复强调的那条陷阱。
const HEADERS = ['source', 'order', 'batches', 'external', 'cycles']
const ENTRIES = new Set(['batches', 'cycles'])

const failure = (line, detail) => new Error(`line ${line}: ${detail}`)

// 缺段落时要指向文本真正停下的那一行，而不是数组里那个不存在的下标：第 5 节只要求消息带行号，但行号
// 指错地方会让读的人去改一个没问题的位置。
const reportAt = (lines, at) => {
  if (at < lines.length) return at + 1
  for (let back = lines.length - 1; back >= 0; back -= 1) if (lines[back].trim()) return back + 1
  return 1
}

const describe = line => (line === undefined ? 'end of text' : JSON.stringify(line.trim()))

export function parsePlan(text) {
  const lines = String(text).split('\n')
  const header = new Map()
  const headerLine = new Map()
  const rows = new Map()
  let at = 0

  for (const section of HEADERS) {
    while (at < lines.length && !lines[at].trim()) at += 1
    const line = at < lines.length ? lines[at].trimEnd() : ''
    if (!line.startsWith(`${section}:`)) throw failure(reportAt(lines, at), `expected "${section}:" section, found ${describe(lines[at])}`)
    header.set(section, line.slice(section.length + 1).trim())
    headerLine.set(section, at + 1)
    at += 1
    if (!ENTRIES.has(section)) continue
    const entries = []
    // 段落内的缩进行才是条目；段落头一起就把这一段读完了。
    while (at < lines.length && /^\s/.test(lines[at])) {
      const match = /^\s+(\d+):\s*(.*)$/.exec(lines[at].trimEnd())
      if (!match) throw failure(at + 1, 'malformed entry')
      if (Number(match[1]) !== entries.length + 1) throw failure(at + 1, 'entry numbers must start at 1 and increase by 1')
      const names = match[2].split(',').map(name => name.trim()).filter(Boolean)
      if (!names.length) throw failure(at + 1, 'entry has no module name')
      entries.push({ line: at + 1, names })
      at += 1
    }
    rows.set(section, entries)
  }
  while (at < lines.length && !lines[at].trim()) at += 1
  if (at < lines.length) throw failure(at + 1, 'unexpected content after the cycles section')

  const source = header.get('source')
  if (!source) throw failure(headerLine.get('source'), 'source cannot be empty')
  const batches = rows.get('batches')
  const declared = header.get('batches')
  if (!/^\d+$/.test(declared) || Number(declared) !== batches.length) throw failure(headerLine.get('batches'), 'batches header must equal the number of batch lines')
  const cycles = rows.get('cycles')
  const declaredCycles = header.get('cycles')
  if (!/^\d+$/.test(declaredCycles) || Number(declaredCycles) !== cycles.length) throw failure(headerLine.get('cycles'), 'cycles header must equal the number of cycle lines')

  const seen = new Set()
  for (const entry of batches) for (const name of entry.names) {
    if (seen.has(name)) throw failure(entry.line, `duplicate module ${name}`)
    seen.add(name)
  }
  const order = batches.flatMap(entry => entry.names)
  const declaredOrder = header.get('order')
  if (!/^\d+$/.test(declaredOrder) || Number(declaredOrder) !== order.length) throw failure(headerLine.get('order'), 'order header must equal the number of modules in batches')

  const externalText = header.get('external')
  const external = externalText === '(none)' ? [] : externalText.split(',').map(name => name.trim()).filter(Boolean)

  return { source, order, batches: batches.map(entry => entry.names), external, cycles: cycles.map(entry => entry.names) }
}
