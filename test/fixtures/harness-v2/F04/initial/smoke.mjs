import assert from 'node:assert/strict'
import { createReport } from './src/index.mjs'
assert.deepEqual(createReport().snapshot(), [])
