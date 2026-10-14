import test from 'node:test'
import assert from 'node:assert/strict'
import { batchArms, classifyArm, classifyBatch } from '../scripts/eval-classify.js'
import type { ArmRun, BatchName } from '../scripts/eval-classify.js'
import type { LedgerPhase } from '../scripts/eval-runner.js'

// NX-38-3 预注册的四类结局是**先于结果**写死的判据，因此它们必须能被离线驱动、且每条分支都有用例。
// 判定顺序固定：被拒 → 仪器未成立 → 天花板被打破 / 未被打破。顺序一旦交换，「被拒」就会被读成
// 「模型没记住」——这正是 NX-08h 的缺口。

// 一次「自然结束」的运行的合成记录。阶段 taskId 用 stage-1/2/…，裁剪记录挂在第 2 个阶段上（第 1 阶段的
// task 只有在后续阶段才可能被裁掉）。
const run = (accepted: boolean, options: { status?: string; peak?: number; pruned?: boolean; pressure?: number; overflow?: number } = {}): ArmRun => ({
  status: options.status ?? 'completed',
  accepted,
  tasks: [
    { taskId: 'stage-1', removedTaskIds: [], maxEstimatedInputTokens: 5_000, compactions: { applied: 0, pressure: 0, declined: 0 } },
    {
      taskId: 'stage-2',
      removedTaskIds: options.pruned ? ['stage-1'] : [],
      maxEstimatedInputTokens: options.peak ?? 9_000,
      compactions: { applied: (options.pressure ?? 0) + (options.overflow ?? 0), pressure: options.pressure ?? 0, declined: 0 },
    },
  ],
})
// 四条臂各 3 次重复（phaseCaps），因此下面的成功样本一律给 3 条。
const thrice = (...records: ArmRun[]) => records

test('a rejected run outranks every other class', () => {
  // 三条运行里只有一条被闸门停下：整臂归入「被拒」，理由逐次点名到第几次。
  const verdict = classifyArm('ledgerA2', thrice(run(true, { pruned: true }), run(false, { status: 'context_overflow' }), run(true, { pruned: true })))
  assert.equal(verdict.state, 'rejected')
  assert.deepEqual(verdict.reasons, ['第 2 次运行以 context_overflow 结束'])
})

test('a phase whose planned runs were never executed counts as rejected, not as clean', () => {
  const verdict = classifyArm('ledgerB1', thrice(run(true, { pressure: 1 })))
  assert.equal(verdict.state, 'rejected')
  assert.deepEqual(verdict.reasons, ['只有 1/3 次运行被执行（整批上限或中断）'])
})

test('batch A is not established when the carrier never leaves the context', () => {
  // A1 正常；A2 三次都跑完但一次都没裁掉第 1 阶段的 task —— 处理从未发生，结局无从解释。
  const verdict = classifyBatch('A', {
    ledgerA1: thrice(run(true, { peak: 500_000 }), run(true, { peak: 520_000 }), run(true, { peak: 540_000 })),
    ledgerA2: thrice(run(true), run(true), run(true)),
  })
  assert.equal(verdict.verdict, 'instrument-not-established')
  assert.match(verdict.reasons.join('\n'), /A2 第 1 次运行没有裁掉第 1 阶段的 task/)
  assert.match(verdict.reasons.join('\n'), /A2 第 3 次运行没有裁掉第 1 阶段的 task/)
})

test('batch A is not established when the two arms pruned to the same size', () => {
  // 两臂都裁了载体，但处理量区间重叠：裁与不裁分不出来，读数不能用来谈结局。
  const verdict = classifyBatch('A', {
    ledgerA1: thrice(run(true, { peak: 9_000, pruned: true }), run(true, { peak: 9_500, pruned: true }), run(true, { peak: 10_000, pruned: true })),
    ledgerA2: thrice(run(true, { peak: 9_200, pruned: true }), run(true, { peak: 9_400, pruned: true }), run(true, { peak: 9_600, pruned: true })),
  })
  assert.equal(verdict.verdict, 'instrument-not-established')
  assert.match(verdict.reasons.join('\n'), /处理量区间重叠/)
})

test('batch B is not established when the self-variable never fires, or when it will not turn off', () => {
  const armA = thrice(run(true, { peak: 10_000, pressure: 1 }), run(true, { peak: 10_000, pressure: 1 }), run(true, { peak: 10_000, pressure: 1 }))
  const quiet = thrice(run(true, { peak: 10_000 }), run(true, { peak: 10_000 }), run(true, { peak: 10_000 }))
  // B1 一次主动压缩都没触发：问的是「模型会不会把它带进自己写的摘要」，而它根本没写过摘要。
  assert.match(classifyBatch('B', { ledgerB1: quiet, ledgerB2: quiet }).reasons.join('\n'), /B1 一次主动压缩都没有触发/)
  // B2 出现了已应用的压缩：「关主动压缩」没关上，两臂差的就不只是这个阈值。
  assert.match(classifyBatch('B', { ledgerB1: armA, ledgerB2: thrice(run(true, { peak: 10_000, pressure: 1 }), run(true, { peak: 10_000 }), run(true, { peak: 10_000 })) }).reasons.join('\n'), /B2 出现了 1 次已应用的压缩/)
})

test('an established instrument with mixed outcomes breaks the ceiling', () => {
  // 层 A 成立（A2 每次都裁掉载体、两臂处理量分得开），且结局取到两个不同的值：这是唯一的「打破」。
  const verdict = classifyBatch('A', {
    ledgerA1: thrice(run(true, { peak: 500_000 }), run(true, { peak: 520_000 }), run(true, { peak: 540_000 })),
    ledgerA2: thrice(run(true, { peak: 6_000, pruned: true }), run(false, { peak: 6_100, pruned: true }), run(true, { peak: 6_200, pruned: true })),
  })
  assert.equal(verdict.verdict, 'ceiling-broken')
  assert.deepEqual(verdict.reasons, ['两臂的 accepted 取到 2 个不同的值'])
})

test('an established instrument with one outcome keeps the ceiling intact', () => {
  const verdict = classifyBatch('B', {
    ledgerB1: thrice(run(true, { peak: 60_000, pressure: 1 }), run(true, { peak: 61_000, pressure: 1 }), run(true, { peak: 62_000, pressure: 1 })),
    ledgerB2: thrice(run(true, { peak: 60_000 }), run(true, { peak: 61_000 }), run(true, { peak: 62_000 })),
  })
  assert.equal(verdict.verdict, 'ceiling-intact')
  assert.deepEqual(verdict.reasons, ['两臂的 accepted 只有一个值（true）'])
  // 全失败也是一个值：仪器成立而结局一致，仍不算打破。
  assert.equal(classifyBatch('B', {
    ledgerB1: thrice(run(false, { peak: 60_000, pressure: 1 }), run(false, { peak: 61_000, pressure: 1 }), run(false, { peak: 62_000, pressure: 1 })),
    ledgerB2: thrice(run(false, { peak: 60_000 }), run(false, { peak: 61_000 }), run(false, { peak: 62_000 })),
  }).verdict, 'ceiling-intact')
})

// 两批的臂映射写在代码里而不是散在调用方，因此它本身要有一条断言：批次 A 的四条臂共用一个 fixture，
// 但「哪两条是一批」错了，后面所有判定都会读到错误的对照。
test('each batch names its own two arms', () => {
  assert.deepEqual(batchArms.A, ['ledgerA1', 'ledgerA2'])
  assert.deepEqual(batchArms.B, ['ledgerB1', 'ledgerB2'])
  const all: LedgerPhase[] = [...batchArms.A, ...batchArms.B]
  assert.equal(new Set(all).size, 4)
  for (const batch of ['A', 'B'] as BatchName[]) for (const phase of batchArms[batch]) assert.ok(phase.startsWith(`ledger${batch}`), phase)
})
