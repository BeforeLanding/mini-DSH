export function detect(header) {
  if (header === 'client,cents') return 'v2'
  if (header === 'customer,total') return 'v1'
  throw new RangeError('unknown import header')
}
