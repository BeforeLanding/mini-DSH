import { matches } from '../query/predicate.mjs'
export const listOrders = (rows, filter) => rows.filter(row => matches(row, filter))
