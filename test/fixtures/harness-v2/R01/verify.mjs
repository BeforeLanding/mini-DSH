import assert from 'node:assert/strict'
import { invokeCases, reportGroups } from '../_shared/probe.mjs'
const workspace = process.argv[2], report = process.argv[3]
const call = (name, args, freeze = false) => invokeCases(workspace, './src/index.mjs', name, args, freeze)
await reportGroups(report, [
  ['behavior-preserved', async () => assert.deepEqual(await call('renderReceipt', [[[{ unitCents: 125, quantity: 2 }, { unitCents: 99, quantity: 1 }]], [[]]]), [{ ok: true, value: 'Total: $3.49' }, { ok: true, value: 'Total: $0.00' }])],
  ['extracted-api', async () => assert.deepEqual(await call('calculateTotal', [[[{ unitCents: 125, quantity: 2 }, { unitCents: 99, quantity: 1 }]]]), [{ ok: true, value: 349 }])],
  ['input-purity', async () => assert.deepEqual(await call('calculateTotal', [[[{ unitCents: 1, quantity: 3 }, { unitCents: 25, quantity: 0 }]]], true), [{ ok: true, value: 3 }])],
  ['edge-values', async () => assert.deepEqual(await call('calculateTotal', [[[]], [[{ unitCents: 0, quantity: 0 }]], [[{ unitCents: 999, quantity: 1 }, { unitCents: 1, quantity: 1 }]]]), [{ ok: true, value: 0 }, { ok: true, value: 0 }, { ok: true, value: 1000 }])],
])
