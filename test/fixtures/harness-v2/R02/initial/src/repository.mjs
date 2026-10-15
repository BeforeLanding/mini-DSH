export function readUser(store, id) {
  if (!store || typeof store !== 'object') throw new TypeError('store must be an object')
  return store[id] ?? null
}
