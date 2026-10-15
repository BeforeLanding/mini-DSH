import { detect } from '../version/detect.mjs'
import { fromV1 } from '../version/v1.mjs'
import { fromV2 } from '../version/v2.mjs'
export function dispatch(header, rows) { const version = detect(header); return rows.map(version === 'v1' ? fromV1 : fromV2) }
