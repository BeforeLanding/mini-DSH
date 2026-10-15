import { readUser } from './repository.mjs'
export function findUser(store, id) { const user = readUser(store, id); return { found: user !== null, user } }
