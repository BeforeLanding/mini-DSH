export function decimalCents(raw) {
  if (!/^(0|[1-9]\d*)\.\d{2}$/.test(raw)) throw new RangeError('invalid decimal amount')
  const [whole, fractional] = raw.split('.')
  return Number(whole) * 100 + Number(fractional)
}
