// 第 10 节的渲染同样是逐字固定的，因此反向解析也按段落头严格推进：两段齐全、按 blocked → cycles
// 的顺序出现，条目编号从 1 起连续，段落头的数字与条目数一致。任何一处不符都带行号报错。
const REASONS = new Set(['cycle', 'depends-on-cycle'])

const failure = (line, detail) => new Error(`line ${line}: ${detail}`)

export function parseAudit(text) {
  const lines = String(text).split('\n')
  let at = 0
  const section = name => {
    while (at < lines.length && !lines[at].trim()) at += 1
    const header = at < lines.length ? lines[at].trimEnd() : ''
    const headerLine = at + 1
    if (!header.startsWith(`${name}:`)) throw failure(headerLine, `expected "${name}:" section`)
    const declared = header.slice(name.length + 1).trim()
    at += 1
    const entries = []
    while (at < lines.length && /^\s/.test(lines[at])) {
      // 空条目（只有序号没有内容）也算不合法，所以这里要求至少一个非空字符。
      const entry = /^\s+(\d+):\s*(\S.*)$/.exec(lines[at].trimEnd())
      if (!entry) throw failure(at + 1, 'malformed entry')
      if (Number(entry[1]) !== entries.length + 1) throw failure(at + 1, 'entry numbers must start at 1 and increase by 1')
      entries.push({ line: at + 1, text: entry[2].trim() })
      at += 1
    }
    if (!/^\d+$/.test(declared) || Number(declared) !== entries.length) throw failure(headerLine, `${name} header must equal the number of entry lines`)
    return entries
  }

  const seen = new Set()
  const blocked = section('blocked').map(entry => {
    const match = /^(\S+) \(([a-z-]+)\)$/.exec(entry.text)
    if (!match) throw failure(entry.line, 'malformed blocked entry')
    if (!REASONS.has(match[2])) throw failure(entry.line, `unknown reason ${match[2]}`)
    if (seen.has(match[1])) throw failure(entry.line, `duplicate module ${match[1]}`)
    seen.add(match[1])
    return { name: match[1], reason: match[2] }
  })
  const cycles = section('cycles').map(entry => entry.text.split(',').map(name => name.trim()).filter(Boolean))
  while (at < lines.length && !lines[at].trim()) at += 1
  if (at < lines.length) throw failure(at + 1, 'unexpected content')
  return { blocked, cycles }
}
