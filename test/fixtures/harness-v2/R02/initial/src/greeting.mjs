import { findUser } from './lookup.mjs'
import { greeting } from './format.mjs'
export function greetUser(store, id) { const user = findUser(store, id); return user ? greeting(user.name) : 'Hello stranger' }
