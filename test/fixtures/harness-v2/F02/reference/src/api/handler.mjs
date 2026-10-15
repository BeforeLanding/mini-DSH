import { parseQuery } from '../query/parse.mjs'
import { listOrders } from '../service/list.mjs'
import { snapshotRows } from '../data/store.mjs'
export function handleQuery(rows, query = {}) { return listOrders(snapshotRows(rows), parseQuery(query)) }
