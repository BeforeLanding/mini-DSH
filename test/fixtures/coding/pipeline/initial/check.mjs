import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseDeps } from './src/parse.mjs'
import { topoOrder } from './src/order.mjs'
import { findCycles } from './src/cycles.mjs'
import { toBatches } from './src/batches.mjs'
import { renderPlan } from './src/report.mjs'
import { diffPlan } from './src/delta.mjs'
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
]

const requested = process.argv[2] === undefined ? stages.length : Number(process.argv[2])
if (!Number.isSafeInteger(requested) || requested < 1 || requested > stages.length) {
  throw new Error(`stage must be an integer between 1 and ${stages.length}`)
}
for (const stage of stages.slice(0, requested)) stage()
console.log('public checks passed')
