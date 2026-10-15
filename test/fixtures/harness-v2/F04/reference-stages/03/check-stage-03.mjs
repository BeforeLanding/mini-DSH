import assert from 'node:assert/strict'
import { createReport } from './src/index.mjs'
const report = createReport()
report.add({ id: '1', account: 'z', amountCents: 8 })
report.add({ id: '1', account: 'a', amountCents: 50 })
report.add({ id: '2', account: 'a', amountCents: 3 })
assert.deepEqual(report.snapshot(), [{ account: 'a', totalCents: 3 }, { account: 'z', totalCents: 8 }])
