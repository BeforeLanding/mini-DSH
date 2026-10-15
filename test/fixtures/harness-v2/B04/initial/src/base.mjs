import { lineCents } from './line.mjs'
export const baseCents = items => items.reduce((sum, item) => sum + lineCents(item), 0)
