import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// 独立验收：用与工作区示例不同的一组输入，检查全部阶段的产物是否都按规格成立。
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

// 验收的注释一直声称覆盖了「环成员的间接依赖者」，但那组输入里其实一个也没有，因此这条语义此前没有
// 任何断言在看守。第 3 节要求 order 只包含「不属于任何环、也不依赖任何环成员（直接或间接）」的模块，
// 而参考解曾把「被排除」当成「已满足」处理，依赖环成员的模块反而排了进去。补一个真正有这种模块的输入。
const downstream = parseDeps('alpha: beta\nbeta: alpha\ndownstream: alpha\nfree: ghost\n').records
assert.deepEqual(topoOrder(downstream, ['alpha', 'beta']), ['free'])
assert.deepEqual(planPipeline('alpha: beta\nbeta: alpha\ndownstream: alpha\nfree: ghost\n').order, ['free'])

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
// SPEC 第 5 节要求的是「文本不符合第 4 节的渲染格式时抛 Error，消息里带行号」，措辞由实现自己定。
// 这里原先钉的是参考解恰好吐出的两个字符串，于是按 SPEC 实现、只是换了消息文本的解法也会失败——验收比
// 任务说明更严，NX-08e2 的烟测就撞在这上面。现在断言 SPEC 真正要求的东西：拒绝，且消息里有行号。
const rejectsWithLineNumber = text => {
  try {
    diffPlan(text, plan)
  } catch (error) {
    assert.ok(error instanceof Error, `expected an Error for ${JSON.stringify(text)}`)
    assert.match(error.message, /line \d+/, `expected a line number for ${JSON.stringify(text)}`)
    return
  }
  assert.fail(`expected diffPlan to reject ${JSON.stringify(text)}`)
}
rejectsWithLineNumber('order: 1\n')
rejectsWithLineNumber('totally wrong\n')

console.log('acceptance passed: pipeline')
