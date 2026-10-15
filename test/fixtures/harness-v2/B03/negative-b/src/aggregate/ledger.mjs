export const netFor = rows => rows.reduce((sum, row) => sum + row.amountCents + (row.kind === 'sale' ? 1 : 0), 0)
