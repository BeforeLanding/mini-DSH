export function mergeConfig(base, overrides) {
  const result = { ...base }
  for (const [key, value] of Object.entries(overrides)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])) result[key] = mergeConfig(result[key], value)
    else result[key] = value
  }
  return result
}
