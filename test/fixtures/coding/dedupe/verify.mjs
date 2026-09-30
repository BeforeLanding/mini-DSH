import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const { uniqueById } = await import(pathToFileURL(path.join(process.argv[2], 'src/unique.mjs')).href)
const items = [{ id: 1, value: 'first' }, { id: '1' }, { id: 1, value: 'last' }, { id: 2 }, { id: '1', value: 'last' }]; const before = structuredClone(items); assert.deepEqual(uniqueById(items), [items[0], items[1], items[3]]); assert.deepEqual(items, before); assert.deepEqual(uniqueById([]), [])
console.log('acceptance passed: dedupe')
