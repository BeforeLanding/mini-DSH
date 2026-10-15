import { pop } from '../state/legacy.mjs'
import { publicJob } from '../clone.mjs'
export const next = scheduler => publicJob(pop(scheduler.state))
