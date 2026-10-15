import { readUser } from './repository.mjs'
export const findUser = (store, id) => readUser(store, id)
