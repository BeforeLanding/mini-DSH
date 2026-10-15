import { findUser } from './lookup.mjs'
import { greeting } from './format.mjs'
export function greetUser(store, id) { const result = findUser(store, id); return result.found ? greeting(result.user.id) : 'Hello stranger' }
