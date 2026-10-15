import assert from 'node:assert/strict'
import { importRecords } from './src/index.mjs'
assert.deepEqual(importRecords('client,cents\nAda,29'), [{ customer: 'Ada', totalCents: 29 }])
