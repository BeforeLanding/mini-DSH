import { remove } from '../state/heap.mjs'
export const cancel = (scheduler, id) => remove(scheduler.state, String(id))
