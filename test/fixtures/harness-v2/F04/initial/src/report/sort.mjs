export const sorted = rows => [...rows].sort((a, b) => a.account.localeCompare(b.account))
