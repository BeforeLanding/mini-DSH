import assert from 'node:assert/strict'
import { paginate } from './src/index.mjs'
assert.deepEqual(paginate([1, 2, 3], 1, 2), [1, 2])
