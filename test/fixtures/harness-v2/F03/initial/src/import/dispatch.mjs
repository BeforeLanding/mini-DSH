import { detect } from '../version/detect.mjs'
import { fromV2 } from '../version/v2.mjs'
export function dispatch(header, rows) { detect(header); return rows.map(fromV2) }
