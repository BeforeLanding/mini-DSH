export const toRows = totals => [...totals].map(([account, totalCents]) => ({ account, totalCents }))
