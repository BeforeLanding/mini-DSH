import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createScheduler, enqueue, next } from './src/index.mjs'
for (const file of ['state/heap.mjs', 'api/scheduler.mjs', 'actions/enqueue.mjs', 'actions/cancel.mjs', 'actions/next.mjs']) assert.doesNotMatch(await fs.readFile(new URL(`./src/${file}`, import.meta.url), 'utf8'), /legacy\.mjs/)
const queue = createScheduler()
enqueue(queue, { id: 'a', priority: 1 })
assert.deepEqual(next(queue), { id: 'a', priority: 1 })
