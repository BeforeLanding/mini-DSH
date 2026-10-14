// 参考产物：读规格、用 rank 的实际返回值判断实现是否符合规格。
// 它必须在**原始缺陷**上以非零退出码结束、在 reference/ 上以 0 结束——这正是 FAIL_TO_PASS。
// 全部判断来自调用结果，不比对源码文本。
import assert from 'node:assert/strict'
import { rank } from './src/rank.mjs'

// 规格第 4 条。
assert.deepEqual(rank([]), [])
// 规格第 1 条：分数不同时按分数降序。
assert.deepEqual(rank([{ id: 'a', score: 2 }, { id: 'b', score: 1 }]).map(player => player.id), ['a', 'b'])
assert.deepEqual(rank([{ id: 'a', score: 1 }, { id: 'b', score: 2 }]).map(player => player.id), ['b', 'a'])
// 规格第 2 条的要害：分数相同时按 id 升序。输入里的 id 次序**故意是反的**——「保持原顺序」与
// 「按 id 升序」在这里给出两个不同的结果，这正是缺陷与规格的分界。
assert.deepEqual(rank([{ id: 'b', score: 1 }, { id: 'a', score: 1 }]).map(player => player.id), ['a', 'b'])
assert.deepEqual(rank([{ id: 'c', score: 5 }, { id: 'b', score: 5 }, { id: 'a', score: 5 }, { id: 'd', score: 9 }]).map(player => player.id), ['d', 'a', 'b', 'c'])
// 规格第 3 条：不得修改传入的数组。
const input = [{ id: 'b', score: 1 }, { id: 'a', score: 2 }]
rank(input)
assert.deepEqual(input.map(player => player.id), ['b', 'a'])
// 输出里的元素是传进来的那些对象本身。
const player = { id: 'a', score: 1 }
assert.equal(rank([player])[0], player)
// 规格第 5 条。
assert.throws(() => rank([{ id: 1, score: 2 }]))
assert.throws(() => rank([{ id: 'a', score: Number.NaN }]))
assert.throws(() => rank([{ id: 'a', score: '2' }]))
assert.throws(() => rank('players'))
