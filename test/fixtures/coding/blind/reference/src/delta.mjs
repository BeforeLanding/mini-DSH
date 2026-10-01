import { parsePlan } from './plan-parse.mjs'

const batchesOf = plan => {
  const at = new Map()
  for (const [index, names] of plan.batches.entries()) for (const name of names) at.set(name, index + 1)
  return at
}

// 解析渲染文本这件事原来住在本模块里（一个只管 batches 段的小读取器）。第 7 阶段把「渲染文本 → 计划
// 对象」抽成 parsePlan 之后，这里改成直接用那一份。同一份格式留两处解析没有好处：两处的校验强度会各自
// 漂移，而第 5 节的判据是「文本不符合第 4 节的渲染格式就报错」，那本来就该由唯一的解析器承担。
// 副作用是校验变严了——原来只认 batches 段，现在段落顺序、各段计数、重复模块都会检查。
export function diffPlan(previousText, plan) {
  const previous = batchesOf(parsePlan(previousText))
  const current = batchesOf(plan)
  const ordered = plan.batches.flat()
  return {
    added: ordered.filter(name => !previous.has(name)),
    removed: [...previous.keys()].filter(name => !current.has(name)),
    moved: ordered
      .filter(name => previous.has(name) && previous.get(name) !== current.get(name))
      .map(name => ({ name, from: previous.get(name), to: current.get(name) })),
  }
}
