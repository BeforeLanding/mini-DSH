import { tenantOf } from './tenant.mjs'
import { idOf } from './id.mjs'
import { timeOf } from './time.mjs'
export const normalize = event => ({ tenant: tenantOf(event), id: idOf(event), at: timeOf(event), severity: event.severity })
