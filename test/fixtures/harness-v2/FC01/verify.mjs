import assert from 'node:assert/strict'
import { invokeCases, reportGroups } from '../_shared/probe.mjs'
const workspace = process.argv[2], report = process.argv[3]
const call = args => invokeCases(workspace, './src/index.mjs', 'isEnabled', args, true)
await reportGroups(report, [
  ['standalone-flags', async () => assert.deepEqual(await call([['a', { flags: { a: true } }], ['b', { flags: { b: false } }]]), [{ ok: true, value: true }, { ok: true, value: false }])],
  ['dependency-chain', async () => assert.deepEqual(await call([['a', { flags: { a: true, b: true, c: true }, requires: { a: ['b'], b: ['c'] } }], ['a', { flags: { a: true, b: true, c: false }, requires: { a: ['b'], b: ['c'] } }]]), [{ ok: true, value: true }, { ok: true, value: false }])],
  ['missing-dependency', async () => assert.deepEqual(await call([['a', { flags: { a: true }, requires: { a: ['missing'] } }]]), [{ ok: true, value: false }])],
  ['cycle-rejection', async () => assert.deepEqual((await call([['a', { flags: { a: true, b: true }, requires: { a: ['b'], b: ['a'] } }]])).map(item => [item.ok, item.name]), [[false, 'RangeError']])],
])
