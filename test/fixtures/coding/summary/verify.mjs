import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const { summarize } = await import(pathToFileURL(path.join(process.argv[2], 'src/summary.mjs')).href)
const events = [{ category: 'z', amount: 2 }, { category: 'a', amount: -1 }, { category: 'z', amount: 3 }, { category: 'a', amount: 0 }], before = structuredClone(events); assert.deepEqual(summarize(events), [{ category: 'a', count: 2, total: -1 }, { category: 'z', count: 2, total: 5 }]); assert.deepEqual(summarize([]), []); assert.deepEqual(events, before)
console.log('acceptance passed: summary')
