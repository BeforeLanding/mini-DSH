// 参考产物：读规格、用 groupSessions 的实际返回值判断实现是否符合规格。
// 它必须在**原始缺陷**上以非零退出码结束、在 reference/ 上以 0 结束——这正是 FAIL_TO_PASS。
// 全部判断来自调用结果，不比对源码文本，因此把 `>=` 改回 `>` 之外的行为保持改写也不会让它失准。
import assert from 'node:assert/strict'
import { groupSessions } from './src/sessions.mjs'

// 规格第 3 条：没有事件时返回空数组。
assert.deepEqual(groupSessions([], 1000), [])
// 规格第 2 条的要害：差值**恰好等于** gapMs 时不断开。这一条是缺陷与规格的分界。
assert.deepEqual(groupSessions([0, 1000, 2000], 1000), [[0, 1000, 2000]])
assert.deepEqual(groupSessions([7, 1007], 1000), [[7, 1007]])
// 差**严格大于** gapMs 时断开。
assert.deepEqual(groupSessions([0, 1001], 1000), [[0], [1001]])
assert.deepEqual(groupSessions([0, 1000, 2001], 1000), [[0, 1000], [2001]])
// 规格第 1 条：先排序，且不修改传入的数组。
const input = [2000, 0, 1000]
assert.deepEqual(groupSessions(input, 1000), [[0, 1000, 2000]])
assert.deepEqual(input, [2000, 0, 1000])
// 规格第 4、5 条。
assert.throws(() => groupSessions([0], 0))
assert.throws(() => groupSessions('0', 1000))
assert.throws(() => groupSessions([-1], 1000))
assert.throws(() => groupSessions([0.5], 1000))
