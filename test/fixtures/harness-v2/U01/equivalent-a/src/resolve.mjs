import { defaults } from './defaults.mjs'
import { parseConfig } from './parse.mjs'

export function resolveConfig({ fileText = '', explicit = {} } = {}) {
  const file = parseConfig(fileText)
  const result = { ...defaults, ...file, ...explicit }
  if (!Number.isInteger(result.retries) || result.retries < 0 || result.retries > 10) throw new RangeError('retries must be 0..10')
  return { region: result.region, retries: result.retries }
}
