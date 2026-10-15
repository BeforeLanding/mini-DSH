import assert from 'node:assert/strict'
import { invokeCases, reportGroups } from '../_shared/probe.mjs'
const workspace = process.argv[2], report = process.argv[3]
const rows = [{ id: 1, status: 'open', total: 100 }, { id: 2, status: 'closed', total: 200 }, { id: 3, status: 'open', total: 200 }]
const call = args => invokeCases(workspace, './src/index.mjs', 'queryOrders', args, true)
await reportGroups(report, [
  ['legacy-call', async () => assert.deepEqual(await invokeCases(workspace, './src/index.mjs', 'legacyList', [[rows]], true), [{ ok: true, value: rows }])],
  ['status-filter', async () => assert.deepEqual(await call([[rows, { status: 'open' }], [rows, { status: 'closed' }]]), [{ ok: true, value: [rows[0], rows[2]] }, { ok: true, value: [rows[1]] }])],
  ['minimum-total', async () => assert.deepEqual(await call([[rows, { minTotal: 200 }], [rows, { minTotal: 201 }]]), [{ ok: true, value: [rows[1], rows[2]] }, { ok: true, value: [] }])],
  ['combined-and-empty', async () => {
    const result = await call([[rows, { status: 'open', minTotal: 200 }], [[], { status: 'open' }], [rows, { status: 'pending' }], [rows, { minTotal: -1 }]])
    assert.deepEqual(result.slice(0, 2), [{ ok: true, value: [rows[2]] }, { ok: true, value: [] }])
    assert.deepEqual(result.slice(2).map(item => [item.ok, item.name]), [[false, 'RangeError'], [false, 'RangeError']])
  }],
])
