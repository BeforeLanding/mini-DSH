import assert from 'node:assert/strict'
import { createScheduler, enqueue, cancel, next } from './src/index.mjs'
const queue = createScheduler()
for (const [id, priority] of [['a', 4], ['b', 1], ['c', 2], ['d', 1]]) enqueue(queue, { id, priority })
assert.ok(Array.isArray(queue.state.data))
assert.equal(queue.state.data[0].id, 'b')
cancel(queue, 'a')
assert.deepEqual([next(queue)?.id, next(queue)?.id, next(queue)?.id, next(queue)], ['b', 'd', 'c', null])
