export function calculateOrder(lines, catalog) {
  return lines.reduce((total, line) => total + (catalog[line.sku] ?? 0) * line.quantity, 0)
}
