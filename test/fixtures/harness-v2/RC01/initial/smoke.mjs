import assert from 'node:assert/strict'
import { createScheduler, enqueue, next } from './src/index.mjs'
const scheduler = createScheduler()
enqueue(scheduler, { id: 'a', priority: 1 })
assert.deepEqual(next(scheduler), { id: 'a', priority: 1 })
