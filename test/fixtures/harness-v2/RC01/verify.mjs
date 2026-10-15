import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { executeScenario, reportGroups } from '../_shared/probe.mjs'
const workspace = process.argv[2], report = process.argv[3]
const run = code => executeScenario(workspace, `import { createScheduler,enqueue,cancel,next } from './src/index.mjs'; ${code}`)
await reportGroups(report, [
  ['priority-and-stability', async () => assert.deepEqual(await run(`const q=createScheduler(); enqueue(q,{id:'a',priority:2}); enqueue(q,{id:'b',priority:1}); enqueue(q,{id:'c',priority:1}); console.log('__V2_RESULT__'+JSON.stringify([next(q),next(q),next(q),next(q)]));`), [{ id: 'b', priority: 1 }, { id: 'c', priority: 1 }, { id: 'a', priority: 2 }, null])],
  ['cancellation', async () => assert.deepEqual(await run(`const q=createScheduler(); enqueue(q,{id:'a',priority:1}); enqueue(q,{id:'b',priority:2}); cancel(q,'a'); console.log('__V2_RESULT__'+JSON.stringify([next(q),next(q)]));`), [{ id: 'b', priority: 2 }, null])],
  ['heap-representation', async () => assert.deepEqual(await run(`const q=createScheduler(); enqueue(q,{id:'a',priority:4}); enqueue(q,{id:'b',priority:1}); enqueue(q,{id:'c',priority:2}); console.log('__V2_RESULT__'+JSON.stringify({data:Array.isArray(q.state.data),root:q.state.data?.[0]?.id}));`), { data: true, root: 'b' })],
  ['legacy-detached', async () => {
    for (const file of ['api/scheduler.mjs', 'actions/enqueue.mjs', 'actions/cancel.mjs', 'actions/next.mjs', 'state/heap.mjs']) assert.doesNotMatch(await fs.readFile(path.join(workspace, 'src', file), 'utf8'), /legacy\.mjs/)
    assert.deepEqual(await run(`const q=createScheduler(); enqueue(q,{id:'x',priority:1}); console.log('__V2_RESULT__'+JSON.stringify(next(q)));`), { id: 'x', priority: 1 })
  }],
])
