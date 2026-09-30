import assert from 'node:assert/strict'
import { paginate } from './src/page.mjs'
assert.deepEqual(paginate([1, 2, 3], 1, 2), { items: [1, 2], totalPages: 2 })
console.log('public checks passed')
