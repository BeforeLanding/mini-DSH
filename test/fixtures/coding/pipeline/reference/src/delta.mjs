const HEADER = /^(source|order|batches|external|cycles):/

// 只读 batches 段的缩进行。cycles 段的成员行同样是缩进行，必须靠段落归属排除，
// 否则环成员会被当成批次成员读进来。
function readBatches(text) {
  const batches = new Map()
  let section = ''
  let seenBatches = false
  // SPEC 第 5 节要求这类错误的消息里带行号，因此「缺 batches 段」也必须有行号可指：指向最后一行有内容的
  // 行——文本就是在那里结束、而没有出现 batches 段的。
  let lastLine = 1
  const lines = String(text).split('\n')
  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at].trimEnd()
    if (!line) continue
    lastLine = at + 1
    if (/^\s/.test(line)) {
      if (section !== 'batches') continue
      const entry = /^\s+(\d+):\s*(.*)$/.exec(line)
      if (!entry) throw new Error(`line ${at + 1}: malformed batch entry`)
      const batch = Number(entry[1])
      if (!Number.isSafeInteger(batch) || batch < 1) throw new Error(`line ${at + 1}: invalid batch number`)
      for (const name of entry[2].split(',').map(item => item.trim()).filter(Boolean)) {
        if (batches.has(name)) throw new Error(`line ${at + 1}: duplicate module ${name}`)
        batches.set(name, batch)
      }
      continue
    }
    if (!HEADER.test(line)) throw new Error(`line ${at + 1}: unknown header`)
    section = line.slice(0, line.indexOf(':'))
    if (section === 'batches') seenBatches = true
  }
  if (!seenBatches) throw new Error(`line ${lastLine}: missing batches section`)
  return batches
}

export function diffPlan(previousText, plan) {
  const previous = readBatches(previousText)
  const ordered = plan.batches.flat()
  const current = new Map()
  for (const [at, batch] of plan.batches.entries()) for (const name of batch) current.set(name, at + 1)
  return {
    added: ordered.filter(name => !previous.has(name)),
    removed: [...previous.keys()].filter(name => !current.has(name)),
    moved: ordered
      .filter(name => previous.has(name) && previous.get(name) !== current.get(name))
      .map(name => ({ name, from: previous.get(name), to: current.get(name) })),
  }
}
