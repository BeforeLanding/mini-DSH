export function netFor(rows) {
  let total = 0
  for (const row of rows) total += row.kind === 'refund' ? -row.amountCents : row.amountCents
  return total
}
