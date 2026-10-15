import { newQueue } from '../state/legacy.mjs'
export const createScheduler = () => ({ state: newQueue() })
