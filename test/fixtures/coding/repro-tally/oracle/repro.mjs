// 参考产物：读规格、用 tallyByKind 的实际返回值判断实现是否符合规格。
// 它必须在**原始缺陷**上以非零退出码结束、在 reference/ 上以 0 结束——这正是 FAIL_TO_PASS。
// 全部判断来自调用结果，不比对源码文本。
import assert from 'node:assert/strict'
import { tallyByKind } from './src/tally.mjs'

// 规格第 5 条。
assert.deepEqual(tallyByKind([]), {})
// 规格第 2、3 条：同名相加、异名分开、键不做改写。
assert.deepEqual(tallyByKind([{ kind: 'food', amount: 1.5 }, { kind: 'food', amount: 2 }, { kind: 'ride', amount: 3 }]), { food: 3.5, ride: 3 })
assert.deepEqual(tallyByKind([{ kind: 'A', amount: 1 }, { kind: 'a', amount: 2 }]), { A: 1, a: 2 })
// 规格第 1 条的要害：类别不合法的条目归入 'other'，**不是被丢掉**。
assert.deepEqual(tallyByKind([{ amount: 5 }]), { other: 5 })
assert.deepEqual(tallyByKind([{ kind: '', amount: 2 }, { kind: 'ride', amount: 1 }]), { other: 2, ride: 1 })
assert.deepEqual(tallyByKind([{ kind: 7, amount: 4 }]), { other: 4 })
assert.deepEqual(tallyByKind([{ kind: null, amount: 1 }, { kind: 'ride', amount: 2 }]), { other: 1, ride: 2 })
// 规格第 4 条：没有条目的类别不得出现在结果里。
assert.deepEqual(Object.keys(tallyByKind([{ kind: 'ride', amount: 1 }])), ['ride'])
// 规格第 6 条。
assert.throws(() => tallyByKind([{ kind: 'ride', amount: Number.NaN }]))
assert.throws(() => tallyByKind([{ kind: 'ride', amount: '1' }]))
assert.throws(() => tallyByKind('ride'))
