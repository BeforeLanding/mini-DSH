import { retry } from './retry.mjs'
export const runJob = (payload, transport, options = {}) => retry(payload, transport, options.signal)
