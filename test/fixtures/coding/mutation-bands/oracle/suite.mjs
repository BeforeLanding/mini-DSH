// 参考套件：逐条覆盖 docs/SPEC.md 的规则，尤其是每一档的**闭区间端点**。
// 它必须在当前源码与全部等价实现上退出 0，并杀掉全部变异体。
import assert from 'node:assert/strict'
import { bandOf } from './src/bands.mjs'

// 规则 5：最低档，以及它的上端点 70（属于下一档）。
assert.equal(bandOf(0), 'D')
assert.equal(bandOf(69), 'D')
// 规则 4。
assert.equal(bandOf(70), 'C')
assert.equal(bandOf(79), 'C')
// 规则 3。
assert.equal(bandOf(80), 'B')
assert.equal(bandOf(89), 'B')
// 规则 2：上端点 100 也是合法输入。
assert.equal(bandOf(90), 'A')
assert.equal(bandOf(100), 'A')
// 规则 1。
assert.throws(() => bandOf(-1))
assert.throws(() => bandOf(101))
assert.throws(() => bandOf(Number.NaN))
assert.throws(() => bandOf(Number.POSITIVE_INFINITY))
assert.throws(() => bandOf('90'))
assert.throws(() => bandOf(null))
// 规则 6：返回值只可能是四个字母之一。
for (const score of [0, 12, 70, 80, 90, 100]) assert.ok(['A', 'B', 'C', 'D'].includes(bandOf(score)))

console.log('oracle suite ok')
