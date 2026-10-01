import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseDeps } from './src/parse.mjs'
import { topoOrder } from './src/order.mjs'
import { findCycles } from './src/cycles.mjs'
import { toBatches } from './src/batches.mjs'
import { renderPlan } from './src/report.mjs'
import { diffPlan } from './src/delta.mjs'
import { parsePlan } from './src/plan-parse.mjs'
import { mergePlans } from './src/plan-merge.mjs'
import { blockReasons } from './src/blocked.mjs'
import { renderAudit } from './src/audit.mjs'
import { planPipeline } from './src/pipeline.mjs'

// 公开检查按阶段累积：`node check.mjs 4` 会重跑第 1 到第 4 阶段的全部断言，后面的阶段还没实现也能跑。
// 每个阶段的断言只使用该阶段应当已经具备的字段与导出，因此同一个文件对所有阶段都成立。
const stages = [
  () => {
    const { records, external } = parseDeps('core: util log\nutil:\nlog: util\n\n# 注释\ncore: log extra\n')
    assert.deepEqual(records, [
      { name: 'core', deps: ['util', 'log', 'extra'] },
      { name: 'util', deps: [] },
      { name: 'log', deps: ['util'] },
    ])
    assert.deepEqual(external, ['extra'])
    assert.throws(() => parseDeps('broken line'), /missing ':'/)
    assert.throws(() => parseDeps('ok:\nbad name: x'), /invalid module name/)
  },
  () => {
    const plan = planPipeline('a: b c\nb: c\nc:\nd: a\n')
    assert.deepEqual(plan.records, [
      { name: 'a', deps: ['b', 'c'] },
      { name: 'b', deps: ['c'] },
      { name: 'c', deps: [] },
      { name: 'd', deps: ['a'] },
    ])
    assert.deepEqual(plan.external, [])
    assert.deepEqual(topoOrder(plan.records), ['c', 'b', 'a', 'd'])
    assert.deepEqual(planPipeline('x: z\ny: z\nz:\nw:\n').order, ['z', 'x', 'y', 'w'])
  },
  () => {
    const text = 'a: b\nb: a\nc: d\nd:\nsolo: solo\n'
    assert.deepEqual(findCycles(parseDeps(text).records), [['a', 'b'], ['solo']])
    const plan = planPipeline(text)
    assert.deepEqual(plan.cycles, [['a', 'b'], ['solo']])
    assert.deepEqual(plan.order, ['d', 'c'])
    // excluded 的语义是「被当作不存在」（第 6 节）：依赖链上没有声明过的名字不参与排序、不影响就绪，
    // 但被排除的模块不能这样处理——否则依赖环成员的模块会因为计数被减掉而提前就绪，排进 order 里。
    const downstream = 'a: b\nb: a\ndownstream: a\nfree: ghost\n'
    assert.deepEqual(topoOrder(parseDeps(downstream).records, ['a', 'b']), ['free'])
    assert.deepEqual(planPipeline(downstream).order, ['free'])
  },
  () => {
    const plan = planPipeline('a: b c\nb: c\nc:\nd: a\n')
    assert.deepEqual(plan.batches, [['c'], ['b'], ['a'], ['d']])
    assert.deepEqual(toBatches(plan.order, plan.records), plan.batches)
    assert.deepEqual(planPipeline('x: z\ny: z\nz:\nw:\n').batches, [['z', 'w'], ['x', 'y']])
  },
  () => {
    const plan = planPipeline('a: b c\nb: c\nc:\nd: a\n')
    assert.equal(renderPlan(plan, { source: 'sample.deps' }),
      'source: sample.deps\norder: 4\nbatches: 4\n  1: c\n  2: b\n  3: a\n  4: d\nexternal: (none)\ncycles: 0\n')
    const other = planPipeline('k: m ghost\nm:\nsolo: solo\n')
    assert.equal(renderPlan(other, { source: 'other.deps' }),
      'source: other.deps\norder: 2\nbatches: 2\n  1: m\n  2: k\nexternal: ghost\ncycles: 1\n  1: solo\n')
  },
  () => {
    const plan = planPipeline('a: b c\nb: c\nc:\nd: a\n')
    const previous = 'source: older.deps\norder: 4\nbatches: 3\n  1: c\n  2: a, legacy\n  3: d\nexternal: (none)\ncycles: 0\n'
    assert.deepEqual(diffPlan(previous, plan),
      { added: ['b'], removed: ['legacy'], moved: [{ name: 'a', from: 2, to: 3 }, { name: 'd', from: 3, to: 4 }] })
    const fromDisk = planPipeline(readFileSync('data/app.deps', 'utf8'))
    assert.deepEqual(diffPlan(readFileSync('data/previous.plan', 'utf8'), fromDisk),
      { added: ['worker'], removed: [], moved: [{ name: 'cli', from: 4, to: 5 }] })
  },
  () => {
    const plan = planPipeline('a: b c\nb: c\nc:\nd: a\n')
    assert.deepEqual(parsePlan(renderPlan(plan, { source: 'sample.deps' })),
      { source: 'sample.deps', order: ['c', 'b', 'a', 'd'], batches: [['c'], ['b'], ['a'], ['d']], external: [], cycles: [] })
    const other = planPipeline('k: m ghost\nm:\nsolo: solo\n')
    assert.deepEqual(parsePlan(renderPlan(other, { source: 'other.deps' })),
      { source: 'other.deps', order: ['m', 'k'], batches: [['m'], ['k']], external: ['ghost'], cycles: [['solo']] })
    // 段落不全、段落头不认识、条目编号跳号都要带行号报错。
    assert.throws(() => parsePlan('order: 1\n'), /line \d+/)
    assert.throws(() => parsePlan('totally wrong\n'), /line \d+/)
    assert.throws(() => parsePlan('source: a.deps\norder: 2\nbatches: 1\n  2: x\nexternal: (none)\ncycles: 0\n'), /line \d+/)
  },
  () => {
    const left = renderPlan(planPipeline('a: b\nb:\n'), { source: 'left.deps' })
    const right = renderPlan(planPipeline('a:\nc: a\n'), { source: 'right.deps' })
    // a 在左是第 2 批、在右是第 1 批，取最大值才不会把它提到 b 之前。
    assert.equal(mergePlans([left, right], { source: 'merged.deps' }),
      'source: merged.deps\norder: 3\nbatches: 2\n  1: b\n  2: a, c\nexternal: (none)\ncycles: 0\n')
    assert.equal(mergePlans([left], { source: 'left.deps' }), left)
    assert.throws(() => mergePlans([], { source: 'none.deps' }), /at least one plan/)
  },
  () => {
    const text = 'a: b\nb: a\ne: a\nf: e\nc: d\nd:\nsolo: solo\nk: ghost\n'
    const plan = planPipeline(text)
    // 优先级 cycle > depends-on-cycle，且后者沿依赖链传递（f 依赖 e，e 依赖环成员 a）。
    // k 依赖外部名 ghost，但外部名不阻挡排序，因此 k 不在 blocked 里。
    assert.deepEqual(plan.blocked, [
      { name: 'a', reason: 'cycle' },
      { name: 'b', reason: 'cycle' },
      { name: 'e', reason: 'depends-on-cycle' },
      { name: 'f', reason: 'depends-on-cycle' },
      { name: 'solo', reason: 'cycle' },
    ])
    assert.deepEqual(blockReasons(plan.records, plan.cycles), plan.blocked)
    assert.deepEqual(planPipeline('c: d\nd:\n').blocked, [])
  },
  () => {
    const plan = planPipeline('a: b\nb: a\ne: a\nc: d\nd:\nsolo: solo\n')
    assert.equal(renderAudit(plan),
      'blocked: 4\n  1: a (cycle)\n  2: b (cycle)\n  3: e (depends-on-cycle)\n  4: solo (cycle)\ncycles: 2\n  1: a, b\n  2: solo\n')
    // 空段落只留段落头：这与第 4 节 external 段写 (none) 的处理不同。
    assert.equal(renderAudit(planPipeline('c: d\nd:\n')), 'blocked: 0\ncycles: 0\n')
  },
]

const requested = process.argv[2] === undefined ? stages.length : Number(process.argv[2])
if (!Number.isSafeInteger(requested) || requested < 1 || requested > stages.length) {
  throw new Error(`stage must be an integer between 1 and ${stages.length}`)
}
for (const stage of stages.slice(0, requested)) stage()
console.log('public checks passed')
