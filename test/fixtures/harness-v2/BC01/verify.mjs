import assert from 'node:assert/strict'
import { invokeCases, reportGroups } from '../_shared/probe.mjs'
const workspace = process.argv[2], report = process.argv[3]
const call = args => invokeCases(workspace, './src/index.mjs', 'groupEvents', args, true)
const event = at => ({ at })
await reportGroups(report, [
  ['positive-offset-rollover', async () => assert.deepEqual(await call([[[event('2024-01-01T23:30:00Z')], 120]]), [{ ok: true, value: [{ day: '2024-01-02', count: 1 }] }])],
  ['negative-offset-rollover', async () => assert.deepEqual(await call([[[event('2024-01-02T00:30:00Z')], -120]]), [{ ok: true, value: [{ day: '2024-01-01', count: 1 }] }])],
  ['ordinary-day', async () => assert.deepEqual(await call([[[event('2024-01-01T12:00:00Z'), event('2024-01-01T13:00:00Z')], 60]]), [{ ok: true, value: [{ day: '2024-01-01', count: 2 }] }])],
  ['empty-and-sort', async () => assert.deepEqual(await call([[[], 480], [[event('2024-01-03T12:00:00Z'), event('2024-01-01T12:00:00Z')], 0]]), [{ ok: true, value: [] }, { ok: true, value: [{ day: '2024-01-01', count: 1 }, { day: '2024-01-03', count: 1 }] }])],
])
