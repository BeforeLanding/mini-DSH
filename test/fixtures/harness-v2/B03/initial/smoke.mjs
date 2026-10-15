import assert from 'node:assert/strict'
import { summarizeBatches } from './src/index.mjs'
assert.deepEqual(summarizeBatches('{"batch":"a","kind":"sale","amountCents":100}\n'), [{ batch: 'a', totalCents: 100 }])
