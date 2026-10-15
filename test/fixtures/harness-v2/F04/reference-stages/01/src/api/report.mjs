import { normalize } from '../event/normalize.mjs'
import { newTotals } from '../state/totals.mjs'
import { toRows } from '../report/rows.mjs'
export function createReport() {
  const totals = newTotals()
  return { add(raw) { const event = normalize(raw); totals.set(event.account, event.amountCents) }, snapshot() { return toRows(totals) } }
}
