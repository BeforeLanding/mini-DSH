import assert from 'node:assert/strict'
import { invokeCases, reportGroups } from '../_shared/probe.mjs'
const workspace = process.argv[2], report = process.argv[3]
const call = args => invokeCases(workspace, './src/index.mjs', 'importRecords', args)
await reportGroups(report, [
  ['v2-unchanged', async () => assert.deepEqual(await call([['client,cents\nAda,29\nBo,1240']]), [{ ok: true, value: [{ customer: 'Ada', totalCents: 29 }, { customer: 'Bo', totalCents: 1240 }] }])],
  ['v1-import', async () => assert.deepEqual(await call([['customer,total\nAda,0.29\nBo,12.40']]), [{ ok: true, value: [{ customer: 'Ada', totalCents: 29 }, { customer: 'Bo', totalCents: 1240 }] }])],
  ['mixed-samples', async () => assert.deepEqual(await call([['customer,total\nX,0.07\nY,4.00'], ['client,cents\nX,7\nY,400']]), Array(2).fill({ ok: true, value: [{ customer: 'X', totalCents: 7 }, { customer: 'Y', totalCents: 400 }] }))],
  ['invalid-input', async () => {
    const result = await call([['customer,total'], ['client,cents'], ['customer,total\nX,-1.00'], ['customer,total\nX,1.234'], ['other,header\nX,1']])
    assert.deepEqual(result.slice(0, 2), [{ ok: true, value: [] }, { ok: true, value: [] }])
    assert.deepEqual(result.slice(2).map(item => [item.ok, item.name]), [[false, 'RangeError'], [false, 'RangeError'], [false, 'RangeError']])
  }],
])
