export const toCsv = rows => ['account,totalCents', ...rows.map(row => `${row.account},${row.totalCents}`)].join('\n') + '\n'
