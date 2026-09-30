export function mergeConfig(base, overrides) {
  return { ...base, ...overrides }
}
