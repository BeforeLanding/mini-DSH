// 参考产物：读规格、用 roundMoney 的实际返回值判断实现是否符合规格。
// 它必须在**原始缺陷**上以非零退出码结束、在 reference/ 上以 0 结束——这正是 FAIL_TO_PASS。
// 全部判断来自调用结果，不比对源码文本。
import assert from 'node:assert/strict'
import { roundMoney } from './src/money.mjs'

assert.equal(roundMoney(0), 0)
assert.equal(roundMoney(1.25), 1.25)
assert.equal(roundMoney(1.234), 1.23)
assert.equal(roundMoney(0.125), 0.13)
// 规格第 2 条的要害：中点向**远离零**的方向进位。正数那一半两种实现一致，分界在负数那一半。
assert.equal(roundMoney(-0.125), -0.13)
assert.equal(roundMoney(-2.375), -2.38)
assert.equal(roundMoney(-1.234), -1.23)
// 规格第 3 条。
assert.equal(roundMoney(-0.001), 0)
// 规格第 4 条。
assert.throws(() => roundMoney(Number.NaN))
assert.throws(() => roundMoney(Number.POSITIVE_INFINITY))
assert.throws(() => roundMoney('1.25'))
