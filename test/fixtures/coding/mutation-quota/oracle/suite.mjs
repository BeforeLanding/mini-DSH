// 参考套件：逐条覆盖 docs/SPEC.md 的规则，尤其是「恰好填满上限」与「越限后不再看后面的条目」。
// 它必须在当前源码与全部等价实现上退出 0，并杀掉全部变异体。
import assert from 'node:assert/strict'
import { takeWithin } from './src/quota.mjs'

const entry = (id, amount) => ({ id, amount })

// 规则 5。
assert.deepEqual(takeWithin([], 10), { ids: [], total: 0 })
// 规则 1：上限 0 是合法输入，什么都装不下。
assert.deepEqual(takeWithin([entry('a', 1)], 0), { ids: [], total: 0 })
// 规则 3：恰好填满上限的那一条要取走。
assert.deepEqual(takeWithin([entry('a', 5)], 5), { ids: ['a'], total: 5 })
assert.deepEqual(takeWithin([entry('a', 4), entry('b', 6)], 10), { ids: ['a', 'b'], total: 10 })
// 规则 3：越限就停，后面的条目即使装得下也不再取。
assert.deepEqual(takeWithin([entry('a', 8), entry('b', 9), entry('c', 1)], 10), { ids: ['a'], total: 8 })
// 规则 2 同时说明「越限之后不再校验」：b 之后的那一条即使不合法也不会抛错。
assert.deepEqual(takeWithin([entry('a', 8), entry('b', 9), { id: '', amount: -1 }], 10), { ids: ['a'], total: 8 })
// 规则 4：顺序与输入一致，总和是已取那些的和。
assert.deepEqual(takeWithin([entry('z', 1), entry('a', 2)], 10), { ids: ['z', 'a'], total: 3 })
assert.deepEqual(takeWithin([entry('a', 3), entry('b', 4)], 10), { ids: ['a', 'b'], total: 7 })

// 规则 1。
assert.throws(() => takeWithin('nope', 1))
assert.throws(() => takeWithin([], -1))
assert.throws(() => takeWithin([], Number.NaN))
assert.throws(() => takeWithin([], Number.POSITIVE_INFINITY))
// 规则 2。
assert.throws(() => takeWithin([{ amount: 1 }], 10))
assert.throws(() => takeWithin([entry('', 1)], 10))
assert.throws(() => takeWithin([entry(7, 1)], 10))
assert.throws(() => takeWithin([entry('a', -1)], 10))
assert.throws(() => takeWithin([entry('a', Number.NaN)], 10))
assert.throws(() => takeWithin([entry('a', '1')], 10))

console.log('oracle suite ok')
