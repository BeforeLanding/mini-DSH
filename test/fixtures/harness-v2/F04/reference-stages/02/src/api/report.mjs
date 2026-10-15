import { normalize } from '../event/normalize.mjs'
import { newTotals } from '../state/totals.mjs'
import { toRows } from '../report/rows.mjs'
export function createReport() {
  const totals = newTotals()
  return { add(raw) { const event = normalize(raw); totals.set(event.account, (totals.get(event.account) ?? 0) + event.amountCents) }, snapshot() { return toRows(totals) } }
}
