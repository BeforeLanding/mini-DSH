import { push } from '../state/legacy.mjs'
import { normalize } from '../normalize.mjs'
export const enqueue = (scheduler, job) => push(scheduler.state, normalize(job))
