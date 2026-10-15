import assert from 'node:assert/strict'
import { invokeCases, reportGroups } from '../_shared/probe.mjs'
const workspace = process.argv[2], report = process.argv[3]
const lines = rows => rows.map(row => JSON.stringify(row)).join('\n')
const call = args => invokeCases(workspace, './src/index.mjs', 'summarizeBatches', args)
const sale = (batch, amountCents) => ({ batch, kind: 'sale', amountCents })
const refund = (batch, amountCents) => ({ batch, kind: 'refund', amountCents })
await reportGroups(report, [
  ['refund-batch', async () => assert.deepEqual(await call([[lines([sale('a', 900), refund('a', -250), sale('a', 100)])]]), [{ ok: true, value: [{ batch: 'a', totalCents: 750 }] }])],
  ['unaffected-batches', async () => assert.deepEqual(await call([[lines([sale('b', 120), sale('a', 100), sale('b', 30)])]]), [{ ok: true, value: [{ batch: 'a', totalCents: 100 }, { batch: 'b', totalCents: 150 }] }])],
  ['order-independent', async () => {
    const rows = [sale('z', 90), refund('z', -20), sale('a', 30), refund('a', -10)]
    assert.deepEqual(await call([[lines(rows)], [lines([...rows].reverse())]]), Array(2).fill({ ok: true, value: [{ batch: 'a', totalCents: 20 }, { batch: 'z', totalCents: 70 }] }))
  }],
  ['empty-and-small', async () => assert.deepEqual(await call([[''], [lines([refund('r', -1)])]]), [{ ok: true, value: [] }, { ok: true, value: [{ batch: 'r', totalCents: -1 }] }])],
])
