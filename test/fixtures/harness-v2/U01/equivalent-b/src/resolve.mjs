import { defaults } from './defaults.mjs'
import { parseConfig } from './parse.mjs'

export function resolveConfig(options = {}) {
  const { fileText = '', explicit = {} } = options
  const file = parseConfig(fileText)
  const choose = key => key in explicit ? explicit[key] : key in file ? file[key] : defaults[key]
  const retries = choose('retries')
  if (!Number.isInteger(retries) || retries < 0 || retries > 10) throw new RangeError('retries must be 0..10')
  return { region: choose('region'), retries }
}
