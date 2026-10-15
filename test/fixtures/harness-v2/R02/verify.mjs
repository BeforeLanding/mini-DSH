import assert from 'node:assert/strict'
import { invokeCases, reportGroups } from '../_shared/probe.mjs'
const workspace = process.argv[2], report = process.argv[3]
const store = { a: { name: 'Ada' }, b: { name: 'Bo' } }
const call = (name, args) => invokeCases(workspace, './src/index.mjs', name, args, true)
await reportGroups(report, [
  ['new-lookup-shape', async () => assert.deepEqual(await call('findUser', [[store, 'a'], [store, 'x']]), [{ ok: true, value: { found: true, user: { name: 'Ada' } } }, { ok: true, value: { found: false, user: null } }])],
  ['old-greeting', async () => assert.deepEqual(await call('greetUser', [[store, 'a'], [store, 'x']]), [{ ok: true, value: 'Hello Ada' }, { ok: true, value: 'Hello stranger' }])],
  ['all-consumers', async () => {
    assert.deepEqual(await call('auditUser', [[store, 'b'], [store, 'x']]), [{ ok: true, value: 'found:b:Bo' }, { ok: true, value: 'missing:x' }])
    assert.deepEqual(await call('badgeUser', [[store, 'a'], [store, 'x']]), [{ ok: true, value: 'A' }, { ok: true, value: '-' }])
  }],
  ['error-propagation', async () => assert.deepEqual((await call('findUser', [[null, 'a']])).map(result => [result.ok, result.name, result.message]), [[false, 'TypeError', 'store must be an object']])],
])
