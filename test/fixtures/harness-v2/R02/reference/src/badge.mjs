import { findUser } from './lookup.mjs'
export function badgeUser(store, id) { const result = findUser(store, id); return result.found ? result.user.name.slice(0, 1).toUpperCase() : '-' }
