import { mergeValue } from './value.mjs'

export function mergeConfig(base, overrides) {
  const result = { ...base }
  for (const [key, value] of Object.entries(overrides)) result[key] = mergeValue(result[key], value)
  return result
}
