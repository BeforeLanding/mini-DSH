import assert from 'node:assert/strict'
import { invokeCases, reportGroups } from '../_shared/probe.mjs'
const workspace = process.argv[2], report = process.argv[3]
const invoke = args => invokeCases(workspace, './src/index.mjs', 'paginate', args)
await reportGroups(report, [
  ['contiguous-pages', async () => assert.deepEqual(await invoke([[[0, 1, 2, 3, 4, 5], 2, 2], [[0, 1, 2, 3, 4, 5], 3, 2]]), [{ ok: true, value: [2, 3] }, { ok: true, value: [4, 5] }])],
  ['boundary-pages', async () => assert.deepEqual(await invoke([[[9, 8, 7, 6, 5], 3, 2], [[9, 8, 7, 6, 5], 4, 2]]), [{ ok: true, value: [5] }, { ok: true, value: [] }])],
  ['empty-input', async () => assert.deepEqual(await invoke([[[], 1, 4], [[], 9, 4]]), [{ ok: true, value: [] }, { ok: true, value: [] }])],
  ['invalid-arguments', async () => {
    const result = await invoke([[[1], 0, 1], [[1], 1, 0], [[1], 1.5, 2]])
    assert.deepEqual(result.map(item => [item.ok, item.name]), [[false, 'RangeError'], [false, 'RangeError'], [false, 'RangeError']])
  }],
])
