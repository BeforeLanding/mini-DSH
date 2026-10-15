import { normalizeLines } from './import/normalize.mjs'
import { headerOf } from './csv/header.mjs'
import { rowsOf } from './csv/rows.mjs'
import { dispatch } from './import/dispatch.mjs'
export function importRecords(text) { const [header, ...body] = normalizeLines(text); return dispatch(headerOf(header), rowsOf(body)) }
