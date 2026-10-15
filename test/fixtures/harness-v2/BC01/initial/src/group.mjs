import { keyOf } from './key.mjs'
import { newCounts } from './count.mjs'
export function group(events, offsetMinutes) { const counts = newCounts(); for (const event of events) { const day = keyOf(event, offsetMinutes); counts.set(day, (counts.get(day) ?? 0) + 1) } return counts }
