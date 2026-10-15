import { localDay } from './day.mjs'
import { milliseconds } from './time.mjs'
export const keyOf = (event, offsetMinutes) => localDay(milliseconds(event), offsetMinutes)
