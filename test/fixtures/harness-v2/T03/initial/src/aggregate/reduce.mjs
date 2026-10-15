import { keyOf } from './key.mjs'
import { newer } from './choose.mjs'
import { newStore } from './store.mjs'
export function reduceEvents(events) {
  const store = newStore()
  for (const event of events) { const key = keyOf(event); store.set(key, store.has(key) ? newer(store.get(key), event) : event) }
  return [...store.values()]
}
