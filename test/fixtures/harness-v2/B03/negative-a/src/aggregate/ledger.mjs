export const netFor = rows => rows.reduce((sum, row) => sum + (row.kind === 'refund' ? 0 : row.amountCents), 0)
