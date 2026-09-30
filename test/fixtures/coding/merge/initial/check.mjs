import assert from 'node:assert/strict'
import { mergeConfig } from './src/merge.mjs'
assert.deepEqual(mergeConfig({ db: { host: 'a', port: 1 } }, { db: { port: 2 } }), { db: { host: 'a', port: 2 } })
console.log('public checks passed')
