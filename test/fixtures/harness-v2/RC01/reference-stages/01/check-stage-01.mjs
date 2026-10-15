import assert from 'node:assert/strict'
import { newQueue, push, pop, remove } from './src/state/heap.mjs'
const queue = newQueue()
push(queue, { id: 'a', priority: 2 })
push(queue, { id: 'b', priority: 1 })
remove(queue, 'a')
assert.equal(pop(queue)?.id, 'b')
assert.equal(pop(queue), null)
