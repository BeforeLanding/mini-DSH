// 工作区里现成的自测：只跑规格里给出的那几个例子。它可以作为起点，但杀不够变异体。
import assert from 'node:assert/strict'
import { takeWithin } from './src/quota.mjs'

const entries = [{ id: 'a', amount: 3 }, { id: 'b', amount: 4 }, { id: 'c', amount: 9 }]
assert.deepEqual(takeWithin(entries, 10), { ids: ['a', 'b'], total: 7 })
assert.deepEqual(takeWithin([], 5), { ids: [], total: 0 })
assert.throws(() => takeWithin('nope', 1))

console.log('check ok')
