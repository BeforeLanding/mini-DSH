import { mergeObject } from './value.mjs'

export function mergeConfig(base, overrides) {
  return mergeObject(base, overrides)
}
