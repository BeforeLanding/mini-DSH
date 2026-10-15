import { normalize } from './event/normalize.mjs'
import { reduceEvents } from './aggregate/reduce.mjs'
import { sorted } from './report/sort.mjs'
import { shape } from './report/shape.mjs'
export const collectAlerts = events => sorted(reduceEvents(events.map(normalize))).map(shape)
