import assert from 'node:assert/strict'
import { invokeCases, reportGroups } from '../_shared/probe.mjs'
const workspace = process.argv[2], report = process.argv[3]
const call = args => invokeCases(workspace, './src/index.mjs', 'computeOrder', args, true)
const item = { unitCents: 1000, quantity: 1 }
await reportGroups(report, [
  ['ordinary-orders', async () => assert.deepEqual(await call([[{ items: [item] }]]), [{ ok: true, value: { netCents: 1000, taxCents: 100, totalCents: 1100 } }])],
  ['discount-tax-base', async () => assert.deepEqual(await call([[{ items: [item], couponCents: 200 }]]), [{ ok: true, value: { netCents: 800, taxCents: 80, totalCents: 880 } }])],
  ['signed-refunds', async () => assert.deepEqual(await call([[{ items: [item], refundCents: -250 }]]), [{ ok: true, value: { netCents: 1000, taxCents: 100, totalCents: 850 } }])],
  ['combined-regression', async () => assert.deepEqual(await call([[{ items: [item], couponCents: 200, refundCents: -250, region: 'B' }], [{ items: [], couponCents: 0, refundCents: 0 }]]), [{ ok: true, value: { netCents: 800, taxCents: 40, totalCents: 590 } }, { ok: true, value: { netCents: 0, taxCents: 0, totalCents: 0 } }])],
])
