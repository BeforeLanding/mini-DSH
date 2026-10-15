import { parseRevision } from './revision.mjs'
export const compare = (a, b) => Math.sign(parseRevision(a).localeCompare(parseRevision(b)))
