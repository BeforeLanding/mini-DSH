export const netFor = rows => rows.reduce((sum, row) => sum + row.amountCents, 0)
