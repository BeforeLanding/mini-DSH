export function renderPlan(plan, { source }) {
  const lines = [`source: ${source}`, `order: ${plan.order.length}`, `batches: ${plan.batches.length}`]
  for (const [at, batch] of plan.batches.entries()) lines.push(`  ${at + 1}: ${batch.join(', ')}`)
  lines.push(`external: ${plan.external.length ? plan.external.join(', ') : '(none)'}`)
  lines.push(`cycles: ${plan.cycles.length}`)
  for (const [at, cycle] of plan.cycles.entries()) lines.push(`  ${at + 1}: ${cycle.join(', ')}`)
  return `${lines.join('\n')}\n`
}
