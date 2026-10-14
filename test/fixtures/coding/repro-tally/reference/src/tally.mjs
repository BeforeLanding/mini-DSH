// 把一批带类别的金额条目按类别求和。完整规则见 docs/SPEC.md。
export function tallyByKind(entries) {
  if (!Array.isArray(entries)) throw new Error('entries must be an array')
  const totals = {}
  for (const entry of entries) {
    if (!Number.isFinite(entry.amount)) throw new Error('amount must be a finite number')
    const kind = typeof entry.kind === 'string' && entry.kind !== '' ? entry.kind : 'other'
    totals[kind] = (totals[kind] ?? 0) + entry.amount
  }
  return totals
}
