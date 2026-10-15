export function fromV2([client, raw]) {
  if (!/^(0|[1-9]\d*)$/.test(raw)) throw new RangeError('invalid cents')
  return { customer: client, totalCents: Number(raw) }
}
