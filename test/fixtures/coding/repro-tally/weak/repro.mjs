// 反例产物：它只检查两种实现都满足的性质，因此在原始缺陷上**也**退出 0——FAIL_TO_PASS 判不过。
// 它的存在是为了让门禁能在离线状态下钉住「这个判据不是白送的」：判据若退化成「能跑就行」，这条会变绿。
import assert from 'node:assert/strict'
import { tallyByKind } from './src/tally.mjs'

assert.deepEqual(tallyByKind([]), {})
assert.deepEqual(tallyByKind([{ kind: 'food', amount: 1 }, { kind: 'food', amount: 2 }]), { food: 3 })
assert.throws(() => tallyByKind('ride'))
