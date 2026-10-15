import { nonemptyLines } from './io/lines.mjs'
import { parseRecord } from './parse/record.mjs'
import { groupRows } from './aggregate/group.mjs'
import { totals } from './aggregate/totals.mjs'
import { renderTotals } from './report/render.mjs'
export const summarizeBatches = text => renderTotals(totals(groupRows(nonemptyLines(text).map(parseRecord))))
