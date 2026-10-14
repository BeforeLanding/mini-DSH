import { checksum } from './checksum.mjs'

// SPEC 第 3 节：逐行的文本，每一行（含最后一行）都以 \n 结尾，因此每行自己补换行再拼，而不是 join('\n')。
export function renderLedger(rows, meta) {
  const lines = [`source: ${meta.source}`, `rows: ${rows.length}`]
  for (const row of rows) lines.push(`  ${row.account} ${row.total} ${row.count}`)
  lines.push(`checksum: ${checksum(meta.entries)}`)
  return lines.map(line => `${line}\n`).join('')
}
