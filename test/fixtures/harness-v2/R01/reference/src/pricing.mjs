export const lineTotal = line => line.unitCents * line.quantity
export const calculateTotal = lines => lines.reduce((sum, line) => sum + lineTotal(line), 0)
