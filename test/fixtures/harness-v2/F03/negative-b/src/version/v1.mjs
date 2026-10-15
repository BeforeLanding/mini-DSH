import { record } from '../schema/record.mjs'
export function fromV1([customer, raw]) { return record(customer, Math.trunc(Number(raw) * 100)) }
