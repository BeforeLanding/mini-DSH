import test from 'node:test'
import assert from 'node:assert/strict'
import { evidenceScope, parseEvalArguments, phaseRegistry, repeatCount, resolveContextWindow, resolveInfeasible, resolveModel, resolvePlanned, resolveRuns } from '../scripts/eval-cli.js'
import { phaseCaps } from '../scripts/eval-runner.js'
import type { PhaseName } from '../scripts/eval-runner.js'
import { screeningIds, sequenceIds } from '../scripts/coding-fixtures.js'

// 入口脚本本身有顶层 await（协议探测、付费批次），被 import 就会花钱，所以真实的参数与计划判据全部
// 住在 eval-cli.ts 的纯函数里，由这里离线钉住。

test('the default plan is the phase registry, not every known fixture', () => {
  // 不带 --tasks 时曾经返回全部 fixtureIds（NX-08e1-1 拆注册表后是 13 项），而 screening 的上限是 12
  // 次运行：第 13 个计划任务永远不会被调度，「跑了 12 个」会被读成「筛出了 12 个」。
  assert.deepEqual(resolvePlanned('screening'), [...screeningIds])
  assert.equal(resolvePlanned('screening').length, 12)
  assert.deepEqual(resolvePlanned('sequence'), ['pipeline'])
  assert.equal(resolvePlanned('sequence').length, sequenceIds.length)
  assert.equal(evidenceScope('screening', resolvePlanned('screening')), 'full')
  assert.equal(evidenceScope('sequence', resolvePlanned('sequence')), 'full')
})

test('a partial selection names its own evidence scope instead of passing as a whole batch', () => {
  assert.equal(evidenceScope('screening', resolvePlanned('screening', 'boundary,merge')), 'boundary-merge')
  // 顺序不同不算整批：目录名是给人看的，改写顺序会落进不同的目录，本来就该分开。
  assert.equal(evidenceScope('screening', ['merge', 'boundary']), 'merge-boundary')
})

// 跨阶段取任务是这次要堵死的陷阱：它让 --tasks pipeline 落在 screening 阶段，套错 phase 标签与上限。
test('--tasks cannot reach outside the selected phase', () => {
  assert.throws(() => resolvePlanned('screening', 'pipeline'), /outside the screening phase: pipeline/)
  assert.throws(() => resolvePlanned('sequence', 'boundary'), /outside the sequence phase: boundary/)
  assert.deepEqual(resolvePlanned('screening', ' boundary , merge '), ['boundary', 'merge'])
  assert.throws(() => resolvePlanned('screening', 'boundary,boundary'), /duplicate fixture ids/)
  assert.throws(() => resolvePlanned('screening', ','), /--tasks must name fixture ids/)
})

// 两臂跑同一份任务集是刻意的：对照 A 比较的是上下文策略，不是任务难度；臂间差异只由 eval-runner 的
// armPolicy 承担（输入目标），因此这里必须相等。
test('both comparison arms plan the same sequence task set', () => {
  assert.deepEqual(phaseRegistry('armA'), ['pipeline'])
  assert.deepEqual(resolvePlanned('armB'), ['pipeline'])
  assert.equal(evidenceScope('armA', resolvePlanned('armA')), 'full')
  assert.equal(phaseRegistry('armA').length, sequenceIds.length)
})

// NX-08e 的事故：armA/armB 的 phaseCaps.runs = 3 当时只被 overCap 当中止阈值用，入口没有任何产生重复
// 的机制（runPhase 遍历的是 registry 那 1 个 fixture），于是「每臂 3 次运行」的预注册一条命令只兑现 1 次；
// --plan-only 还把上限当计划打印，让它在花钱之前看不出破绽。这条断言把两者钉死在一起，是当时缺的那一环。
test('every phase schedules exactly as many runs as its cap pre-registers', () => {
  const phases: readonly PhaseName[] = ['screening', 'armA', 'armB', 'sequence']
  for (const phase of phases) assert.equal(resolveRuns(phase).length, phaseCaps[phase].runs, phase)
  // 两臂的差异只能来自上下文策略，不能来自跑了几次或跑了哪些任务，因此执行清单必须逐字相同。
  assert.deepEqual(resolveRuns('armA'), resolveRuns('armB'))
  assert.deepEqual(resolveRuns('armA'), [
    { id: 'pipeline', repeat: 0 },
    { id: 'pipeline', repeat: 1 },
    { id: 'pipeline', repeat: 2 },
  ])
  assert.deepEqual(resolveRuns('sequence'), [{ id: 'pipeline', repeat: 0 }])
})

// 重复数从整份 registry 推，不从 --tasks 的子集推：从子集推会把「只跑 2 个 fixture」放大成「每个跑 6 遍」，
// 多花 4 倍的钱。子集只减少运行次数，不改变每个 fixture 跑几遍。
test('a subset selection reduces the run count instead of inflating repeats', () => {
  assert.equal(repeatCount(12, 12), 1)
  assert.equal(repeatCount(3, 1), 3)
  assert.equal(resolveRuns('screening', 'boundary,merge').length, 2)
  assert.deepEqual(resolveRuns('screening', 'boundary,merge').map(run => run.repeat), [0, 0])
  assert.equal(resolveRuns('armA', 'pipeline').length, 3)
})

// 「一共几次」与「跑哪些」对不上时必须直接失败，而不是取整：这正是 NX-08e 少跑 4 次的成因。
test('a run count that does not divide evenly across the registry is rejected', () => {
  assert.throws(() => repeatCount(4, 3), /cannot be split evenly across 3 fixtures/)
  assert.throws(() => repeatCount(0, 1), /cannot be split evenly across 1 fixtures/)
  assert.throws(() => repeatCount(3, 0), /registry cannot be empty/)
})

test('arguments are parsed into one options object with screening as the default phase', () => {
  assert.deepEqual(parseEvalArguments([]), { phase: 'screening', probeOnly: false, planOnly: false })
  assert.deepEqual(parseEvalArguments(['--phase', 'sequence', '--plan-only']), { phase: 'sequence', probeOnly: false, planOnly: true })
  assert.deepEqual(parseEvalArguments(['--phase=sequence', '--tasks=pipeline']), { phase: 'sequence', tasks: 'pipeline', probeOnly: false, planOnly: false })
  assert.throws(() => parseEvalArguments(['--phase', 'bogus']), /unknown phase: bogus; expected one of screening, armA, armB, sequence/)
  assert.throws(() => parseEvalArguments(['--phase']), /--phase needs a value/)
  assert.throws(() => parseEvalArguments(['--plan-only=yes']), /--plan-only takes no value/)
  assert.throws(() => parseEvalArguments(['--unknown']), /unknown option: --unknown/)
  assert.throws(() => parseEvalArguments(['sequence']), /unexpected argument: sequence/)
})

// 不可行是人的判断且影响成功率分母：不给理由就不允许使用这个口径，理由也不能是空白。
test('declaring a task infeasible requires a stated reason', () => {
  assert.deepEqual(resolveInfeasible('screening', undefined, undefined), { ids: new Set(), reason: undefined })
  assert.throws(() => resolveInfeasible('screening', undefined, 'no spec'), /--infeasible-reason without --infeasible/)
  assert.throws(() => resolveInfeasible('screening', 'merge', undefined), /--infeasible requires --infeasible-reason/)
  assert.throws(() => resolveInfeasible('screening', 'merge', '   '), /--infeasible requires --infeasible-reason/)
  const declared = resolveInfeasible('screening', 'merge', ' spec is contradictory ')
  assert.deepEqual([...declared.ids], ['merge'])
  assert.equal(declared.reason, 'spec is contradictory')
})

// 窗口必须显式：自定义端点不允许靠模型名猜容量，否则投影会静默退化成无上限。
test('the evaluation model and context window come from explicit configuration', () => {
  assert.equal(resolveModel({ MINI_DSH_MODEL: 'deepseek/deepseek-v4-flash' }), 'deepseek/deepseek-v4-flash')
  assert.equal(resolveModel({ MINI_DSH_MODEL: 'a', MINI_DSH_EVAL_MODEL: 'b' }), 'b')
  assert.throws(() => resolveModel({}), /MINI_DSH_MODEL is required/)
  assert.throws(() => resolveModel({ MINI_DSH_MODEL: '  ' }), /MINI_DSH_MODEL is required/)

  assert.equal(resolveContextWindow({}, 'https://api.deepseek.com'), 1_000_000)
  assert.equal(resolveContextWindow({ MINI_DSH_EVAL_CONTEXT_WINDOW: '200000' }, 'https://api.deepseek.com'), 200_000)
  assert.throws(() => resolveContextWindow({}, 'https://example.com'), /required for a non-official endpoint/)
  assert.throws(() => resolveContextWindow({ MINI_DSH_EVAL_CONTEXT_WINDOW: '0' }, 'https://api.deepseek.com'), /positive safe integer/)
  assert.throws(() => resolveContextWindow({ MINI_DSH_EVAL_CONTEXT_WINDOW: 'many' }, 'https://api.deepseek.com'), /positive safe integer/)
})
