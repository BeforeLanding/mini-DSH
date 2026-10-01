import test from 'node:test'
import assert from 'node:assert/strict'
import { evidenceScope, parseEvalArguments, phaseRegistry, resolveContextWindow, resolveInfeasible, resolveModel, resolvePlanned } from '../scripts/eval-cli.js'
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

// 对照臂的任务集在 NX-08e2 重预注册之前不存在；沿用旧算式（12 任务 × 2 臂 × 3 次）会假装它还成立。
test('the comparison arms refuse to plan until their task set is re-registered', () => {
  assert.throws(() => phaseRegistry('armA'), /尚未预注册/)
  assert.throws(() => resolvePlanned('armB'), /尚未预注册/)
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
