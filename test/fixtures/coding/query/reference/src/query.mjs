export function buildQuery(params) {
  const entries = Object.entries(params).sort(([a], [b]) => a.localeCompare(b))
  return entries.flatMap(([key, value]) => {
    if (value == null) return []
    return (Array.isArray(value) ? value : [value]).map(item => `${encodeURIComponent(key)}=${encodeURIComponent(String(item))}`)
  }).join('&')
}
