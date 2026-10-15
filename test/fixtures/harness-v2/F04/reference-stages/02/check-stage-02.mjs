import assert from 'node:assert/strict'
import { createReport } from './src/index.mjs'
const report = createReport()
report.add({ id: '1', account: 'a', amountCents: 10 })
const before = report.snapshot()
report.add({ id: '2', account: 'a', amountCents: 5 })
assert.deepEqual(before, [{ account: 'a', totalCents: 10 }])
assert.deepEqual(report.snapshot(), [{ account: 'a', totalCents: 15 }])
