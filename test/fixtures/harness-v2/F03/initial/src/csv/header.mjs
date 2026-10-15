import { splitCells } from './split.mjs'
export const headerOf = line => splitCells(line).join(',')
