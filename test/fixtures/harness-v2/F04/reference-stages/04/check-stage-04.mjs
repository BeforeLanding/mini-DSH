import assert from 'node:assert/strict'
import { createReport } from './src/index.mjs'
const report = createReport()
assert.equal(report.exportCsv(), 'account,totalCents\n')
report.add({ id: '1', account: 'z', amountCents: 8 })
report.add({ id: '2', account: 'a', amountCents: 3 })
assert.equal(report.exportCsv(), 'account,totalCents\na,3\nz,8\n')
