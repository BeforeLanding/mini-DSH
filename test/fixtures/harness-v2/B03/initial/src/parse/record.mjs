import { parseJson } from './json.mjs'
import { batchId } from './batch.mjs'
import { kindOf } from './kind.mjs'
import { amountOf } from './amount.mjs'
export const parseRecord = line => { const raw = parseJson(line); return { batch: batchId(raw), kind: kindOf(raw), amountCents: amountOf(raw) } }
