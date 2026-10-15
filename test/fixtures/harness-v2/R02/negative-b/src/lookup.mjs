import { readUser } from './repository.mjs'
export function findUser(store, id) { try { const user = readUser(store, id); return { found: user !== null, user } } catch { return { found: false, user: null } } }
