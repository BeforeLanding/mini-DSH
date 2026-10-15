import { splitCells } from './split.mjs'
export const rowsOf = lines => lines.filter(Boolean).map(splitCells)
