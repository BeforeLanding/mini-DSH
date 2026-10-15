import assert from 'node:assert/strict'
import { legacyList } from './src/index.mjs'
const rows = [{ id: 1, status: 'open', total: 10 }, { id: 2, status: 'closed', total: 20 }]
assert.deepEqual(legacyList(rows), rows)
