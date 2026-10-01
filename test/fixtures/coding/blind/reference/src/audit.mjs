// 与第 4 节同一套排版约定：段落头一行，条目行两个空格缩进加「序号: 」，段号从 1 开始，
// 模块名之间用 `, ` 连接，整个字符串以一个换行符结尾。空段落只留段落头，不写条目行。
export function renderAudit(plan) {
  const lines = [`blocked: ${plan.blocked.length}`]
  for (const [at, entry] of plan.blocked.entries()) lines.push(`  ${at + 1}: ${entry.name} (${entry.reason})`)
  lines.push(`cycles: ${plan.cycles.length}`)
  for (const [at, cycle] of plan.cycles.entries()) lines.push(`  ${at + 1}: ${cycle.join(', ')}`)
  return `${lines.join('\n')}\n`
}
