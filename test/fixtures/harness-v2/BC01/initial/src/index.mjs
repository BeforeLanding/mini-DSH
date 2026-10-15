import { group } from './group.mjs'
import { sorted } from './sort.mjs'
import { rowsOf } from './response.mjs'
export const groupEvents = (events, offsetMinutes = 0) => rowsOf(sorted(group(events, offsetMinutes)))
