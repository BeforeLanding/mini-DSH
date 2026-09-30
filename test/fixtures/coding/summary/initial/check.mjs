import assert from 'node:assert/strict'
import { summarize } from './src/summary.mjs'
assert.deepEqual(summarize([{ category: 'a', amount: 1 }, { category: 'a', amount: 2 }]), [{ category: 'a', count: 2, total: 3 }])
console.log('public checks passed')
