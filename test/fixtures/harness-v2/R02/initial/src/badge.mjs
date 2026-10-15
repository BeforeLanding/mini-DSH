import { findUser } from './lookup.mjs'
export function badgeUser(store, id) { const user = findUser(store, id); return user ? user.name.slice(0, 1).toUpperCase() : '-' }
