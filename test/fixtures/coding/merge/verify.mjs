import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const { mergeConfig } = await import(pathToFileURL(path.join(process.argv[2], 'src/merge.mjs')).href)
const base = { db: { host: 'a', auth: { user: 'u', pass: 'p' } }, tags: ['old'], enabled: true }; const patch = { db: { auth: { pass: 'new' } }, tags: ['new'], enabled: false }; const original = structuredClone(base), originalPatch = structuredClone(patch); assert.deepEqual(mergeConfig(base, patch), { db: { host: 'a', auth: { user: 'u', pass: 'new' } }, tags: ['new'], enabled: false }); assert.deepEqual(mergeConfig({ a: 1 }, { a: null }), { a: null }); assert.deepEqual(base, original); assert.deepEqual(patch, originalPatch)
console.log('acceptance passed: merge')
