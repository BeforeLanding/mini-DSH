function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function mergeObject(base, overrides) {
  const result = { ...base }
  for (const [key, value] of Object.entries(overrides)) {
    result[key] = isPlainObject(value) && isPlainObject(result[key])
      ? mergeObject(result[key], value)
      : value
  }
  return result
}
