import { remove } from '../state/legacy.mjs'
export const cancel = (scheduler, id) => remove(scheduler.state, String(id))
