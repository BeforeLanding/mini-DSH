export function parseCsvLine(line) {
  const fields = []
  let value = '', quoted = false
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (char === '"') {
      if (quoted && line[i + 1] === '"') { value += '"'; i++ }
      else quoted = !quoted
    } else if (char === ',' && !quoted) { fields.push(value); value = '' }
    else value += char
  }
  fields.push(value)
  return fields
}
