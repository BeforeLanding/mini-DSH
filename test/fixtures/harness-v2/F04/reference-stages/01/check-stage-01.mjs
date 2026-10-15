import assert from 'node:assert/strict'
import { createReport } from './src/index.mjs'
const report = createReport()
report.add({ id: '1', account: 'a', amountCents: 10 })
report.add({ id: '2', account: 'b', amountCents: 20 })
assert.deepEqual(report.snapshot(), [{ account: 'a', totalCents: 10 }, { account: 'b', totalCents: 20 }])
