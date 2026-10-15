import { pop } from '../state/heap.mjs'
import { publicJob } from '../clone.mjs'
export const next = scheduler => publicJob(pop(scheduler.state))
