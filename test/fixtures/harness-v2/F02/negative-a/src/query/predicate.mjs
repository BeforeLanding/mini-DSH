export const matches = (row, filter) => filter.minTotal === undefined || row.total >= filter.minTotal
