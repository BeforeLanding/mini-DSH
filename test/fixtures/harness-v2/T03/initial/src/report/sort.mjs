export const sorted = events => [...events].sort((a, b) => a.tenant.localeCompare(b.tenant) || a.id.localeCompare(b.id))
