import { parsePlan } from './plan-parse.mjs'
import { renderPlan } from './report.mjs'

// 合并的唯一约束是「不把模块提到它的依赖之前」。批号取各输入里的最大值，因此合并结果里没有任何模块
// 会排到它在某一份输入中的位置之前；批内次序先按输入数组的顺序，再按该输入内的 order 次序。
// 最大值可能让中间某些批号空出来（两份输入都把某个模块放在第 3 批，第 2 批就没人），按第 3 节
// 「输出时不跳号」的约定压掉空批，否则渲染出来的编号会跳。
const sameMembers = (left, right) => left.length === right.length && [...left].sort().join('\0') === [...right].sort().join('\0')

export function mergePlans(texts, { source }) {
  if (!texts.length) throw new Error('mergePlans needs at least one plan')
  const plans = texts.map(parsePlan)
  const position = new Map()
  const batch = new Map()
  for (const plan of plans) {
    for (const [at, names] of plan.batches.entries()) for (const name of names) {
      if (!position.has(name)) position.set(name, position.size)
      batch.set(name, Math.max(batch.get(name) ?? 1, at + 1))
    }
  }
  const layered = []
  for (const name of [...position.keys()].sort((a, b) => position.get(a) - position.get(b))) {
    const at = batch.get(name) - 1
    while (layered.length <= at) layered.push([])
    layered[at].push(name)
  }
  const batches = layered.filter(names => names.length)
  // 外部依赖与环同样取并集：环按成员集合去重，成员顺序沿用最先出现的那一份。
  const external = []
  const cycles = []
  for (const plan of plans) {
    for (const name of plan.external) if (!external.includes(name)) external.push(name)
    for (const cycle of plan.cycles) if (!cycles.some(existing => sameMembers(existing, cycle))) cycles.push(cycle)
  }
  return renderPlan({ order: batches.flat(), batches, external, cycles }, { source })
}
