import { defaults } from './defaults.mjs'
import { parseConfig } from './parse.mjs'

export function resolveConfig({ fileText = '', explicit = {} } = {}) {
  const file = parseConfig(fileText)
  const region = explicit.region ?? file.region ?? defaults.region
  const retries = explicit.retries ?? file.retries ?? defaults.retries
  if (!Number.isInteger(retries) || retries < 0 || retries > 10) throw new RangeError('retries must be 0..10')
  return { region, retries }
}
