export function calculateOrder(lines, catalog) {
  const missing = []
  let total = 0
  for (const line of lines) {
    if (!Object.hasOwn(catalog, line.sku)) missing.push(line.sku)
    else total += catalog[line.sku] * line.quantity
  }
  return { total, missing }
}
