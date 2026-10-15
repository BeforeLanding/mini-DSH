export const sorted = rows => [...rows].sort((a, b) => a.sku.localeCompare(b.sku))
