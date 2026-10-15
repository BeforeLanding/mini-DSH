import assert from 'node:assert/strict'
import { invokeCases, reportGroups } from '../_shared/probe.mjs'
const workspace = process.argv[2], report = process.argv[3]
const call = args => invokeCases(workspace, './src/index.mjs', 'slugify', args)
await reportGroups(report, [
  ['legacy-default', async () => assert.deepEqual(await call([['  Blue   Sky  '], ['A\tB\nC']]), [{ ok: true, value: 'blue-sky' }, { ok: true, value: 'a-b-c' }])],
  ['custom-separator', async () => assert.deepEqual(await call([['  Blue   Sky  ', { separator: '_' }], ['A B', { separator: '-' }]]), [{ ok: true, value: 'blue_sky' }, { ok: true, value: 'a-b' }])],
  ['invalid-option', async () => assert.deepEqual((await call([['a b', { separator: '/' }], ['a b', { separator: '' }]])).map(item => [item.ok, item.name]), [[false, 'RangeError'], [false, 'RangeError']])],
  ['unicode-and-purity', async () => {
    const result = await invokeCases(workspace, './src/index.mjs', 'slugify', [['  Ａ  É  ', { separator: '_' }], ['  A  É  ', { separator: '-' }]], true)
    assert.deepEqual(result, [{ ok: true, value: 'a_é' }, { ok: true, value: 'a-é' }])
  }],
])
