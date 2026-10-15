import { decimalCents } from '../money/parse.mjs'
import { validCents } from '../money/cents.mjs'
import { record } from '../schema/record.mjs'
export function fromV1([customer, raw]) {
  const totalCents = decimalCents(raw)
  if (!validCents(totalCents)) throw new RangeError('invalid total')
  return record(customer, totalCents)
}
