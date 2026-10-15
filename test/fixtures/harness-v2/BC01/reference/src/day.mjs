import { shifted } from './offset.mjs'
export const localDay = (ms, offsetMinutes) => new Date(shifted(ms, offsetMinutes)).toISOString().slice(0, 10)
