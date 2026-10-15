import assert from 'node:assert/strict'
import { createScheduler, enqueue, cancel, next } from './src/index.mjs'
const queue = createScheduler()
assert.ok(Array.isArray(queue.state.jobs))
enqueue(queue, { id: 'a', priority: 2 })
enqueue(queue, { id: 'b', priority: 1 })
cancel(queue, 'a')
assert.deepEqual(next(queue), { id: 'b', priority: 1 })
assert.equal(next(queue), null)
