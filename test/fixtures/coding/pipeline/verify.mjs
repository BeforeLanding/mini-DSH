import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// 独立验收：用与工作区示例不同的一组输入，检查六个阶段的产物是否都按规格成立。
// 只从工作区读实现，不读工作区的检查逻辑；整个脚本只打印一行标记。
const root = process.argv[2]
const load = name => import(pathToFileURL(path.join(root, 'src', name)).href)
const { parseDeps } = await load('parse.mjs')
const { topoOrder } = await load('order.mjs')
const { findCycles } = await load('cycles.mjs')
const { toBatches } = await load('batches.mjs')
const { renderPlan } = await load('report.mjs')
const { diffPlan } = await load('delta.mjs')
const { planPipeline } = await load('pipeline.mjs')

// 覆盖：重复声明合并、自环、三元环、外部依赖、批量并列、环成员的间接依赖者。
const spec = [
  'alpha: beta gamma',
  'beta: gamma',
  'gamma:',
  'beta: delta',
  'delta: alpha',
  'solo: solo',
  'util:',
  'tool: util ghost',
].join('\n')

const merged = parseDeps('m: a\nm: b\nm: a\n')
assert.deepEqual(merged.records, [{ name: 'm', deps: ['a', 'b'] }])
assert.deepEqual(merged.external, ['a', 'b'])
assert.throws(() => parseDeps('\nno colon here\n'), /missing ':'/)
assert.throws(() => parseDeps('ok:\nbad name: x\n'), /invalid module name/)

const records = parseDeps(spec).records
assert.deepEqual(findCycles(records), [['alpha', 'beta', 'delta'], ['solo']])
assert.deepEqual(topoOrder(records, ['alpha', 'beta', 'delta', 'solo']), ['gamma', 'util', 'tool'])

const plan = planPipeline(spec)
assert.deepEqual(plan.external, ['ghost'])
assert.deepEqual(plan.cycles, [['alpha', 'beta', 'delta'], ['solo']])
assert.deepEqual(plan.order, ['gamma', 'util', 'tool'])
assert.deepEqual(plan.batches, [['gamma', 'util'], ['tool']])
assert.deepEqual(toBatches(plan.order, plan.records), plan.batches)

const rendered = renderPlan(plan, { source: 'private.deps' })
assert.equal(rendered, [
  'source: private.deps',
  'order: 3',
  'batches: 2',
  '  1: gamma, util',
  '  2: tool',
  'external: ghost',
  'cycles: 2',
  '  1: alpha, beta, delta',
  '  2: solo',
  '',
].join('\n'))

// cycles 段的成员行也是缩进行：若被当成批次读进来，模块集合会多出四个，这里立刻会不等。
assert.deepEqual(diffPlan(rendered, plan), { added: [], removed: [], moved: [] })

const previous = [
  'source: older.deps',
  'order: 3',
  'batches: 3',
  '  1: gamma',
  '  2: legacy',
  '  3: tool',
  'external: (none)',
  'cycles: 0',
  '',
].join('\n')
assert.deepEqual(diffPlan(previous, plan), { added: ['util'], removed: ['legacy'], moved: [{ name: 'tool', from: 3, to: 2 }] })
assert.throws(() => diffPlan('order: 1\n', plan), /missing batches section/)
assert.throws(() => diffPlan('totally wrong\n', plan), /unknown header/)

console.log('acceptance passed: pipeline')
