import { netFor } from './ledger.mjs'
export const totals = groups => [...groups].map(([batch, rows]) => ({ batch, totalCents: netFor(rows) }))
