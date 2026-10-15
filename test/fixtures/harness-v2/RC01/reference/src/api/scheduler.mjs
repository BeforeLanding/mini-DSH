import { newQueue } from '../state/heap.mjs'
export const createScheduler = () => ({ state: newQueue() })
