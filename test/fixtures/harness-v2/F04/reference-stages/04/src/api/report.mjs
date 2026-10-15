import { normalize } from '../event/normalize.mjs'
import { newTotals } from '../state/totals.mjs'
import { newSeen } from '../state/seen.mjs'
import { toRows } from '../report/rows.mjs'
import { sorted } from '../report/sort.mjs'
import { toCsv } from '../report/csv.mjs'
export function createReport() {
  const totals = newTotals(), seen = newSeen()
  const snapshot = () => sorted(toRows(totals))
  return { add(raw) { const event = normalize(raw); if (seen.has(event.id)) return; seen.add(event.id); totals.set(event.account, (totals.get(event.account) ?? 0) + event.amountCents) }, snapshot, exportCsv() { return toCsv(snapshot()) } }
}
