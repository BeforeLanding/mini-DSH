import { findUser } from './lookup.mjs'
export function auditUser(store, id) { const user = findUser(store, id); return user ? `found:${id}:${user.name}` : `missing:${id}` }
