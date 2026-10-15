export function parseConfig(text = '') {
  const values = {}
  for (const line of text.split(/\r?\n/)) {
    const [key, raw] = line.split('=')
    if (key === 'region') values.region = raw
    if (key === 'retries') values.retries = Number(raw)
  }
  return values
}
