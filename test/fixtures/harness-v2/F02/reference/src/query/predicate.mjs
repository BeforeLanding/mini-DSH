export const matches = (row, filter) => (filter.status === undefined || row.status === filter.status) && (filter.minTotal === undefined || row.total >= filter.minTotal)
