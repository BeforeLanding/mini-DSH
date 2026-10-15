import { findUser } from './lookup.mjs'
export function auditUser(store, id) { const result = findUser(store, id); return result.found ? `found:${id}:${result.user.name}` : `missing:${id}` }
