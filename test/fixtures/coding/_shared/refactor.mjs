// NX-39「重构」类判据的另一半：**行为不变**。
//
// 重构的定义是「改结构、不改行为」，所以判据只能是**差分**：把改动前的实现拿来当参照物，对同一批输入
// 断言两者算出同一个数。参照物取自 fixture 目录下的 `initial/`——它本来就是交给 agent 的起点，不是隐藏件；
// 隐藏的是**判据本身**（这批输入、以及「必须逐位相同」这条规则），它住在工作区之外（R-23）。
//
// 为什么不另写一张期望值表：那张表是照着参考解抄下来的答案，参考解改一次就得跟着改，而且它测不出
// 「参考解与改动前在这一维上是否真的没变」——那恰好是重构类判据要问的唯一一件事。用改动前的那份实现
// 当参照物，这条是**定义上**成立的，不靠维护。
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 从 fixture 目录（工作区之外）加载 `initial/src/<name>`。它与工作区里的初始态逐字相同，但不受 agent
// 改动影响——这正是它能在验收时当参照物的原因。
export async function loadPristine(verifierUrl, ...names) {
  const directory = path.dirname(fileURLToPath(verifierUrl))
  return Promise.all(names.map(name => import(pathToFileURL(path.join(directory, 'initial', 'src', name)).href)))
}

// 确定性伪随机：判据的**输入空间**必须在任何机器、任何一次运行上逐字相同，否则「这次过了」与「上次没过」
// 就不是同一件事，失败也无法复现。LCG 的常数取自 Numerical Recipes，够用，且一眼看得出没有别的机关。
export function generated(seed, count, build) {
  let state = seed >>> 0
  const next = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32)
  return Array.from({ length: count }, () => build(next))
}
export const pick = (next, list) => list[Math.floor(next() * list.length)]
export const integer = (next, max) => Math.floor(next() * (max + 1))

// 「行为不变」那一段。它只看**数值语义与纯度**，刻意**不看返回值的形状**——形状正是任务点名要改的东西。
// 把形状并进这一段，它就不再是「行为不变」：初始态会因为形状尚未改而判不过，于是「这次改动破坏了行为」
// 与「这次改动还没做完」被压成同一个读数，而报告里两者是两回事（前者是失败，后者只是没完成）。
//   before(input)    改动前的实现算出的**数**
//   candidate(input) 工作区里的实现，返回什么都行
//   unwrap(value)    从两者里取出那个数（改前是数字本身，改后是 `{ amount }`）
// 命中时抛出的消息以「行为不变：」开头，与「新接口：」那一段分得开——门禁按这个前缀核对「初始态判不过
// 的原因是形状还没改，而不是行为已经不对了」。
export function assertPreserved({ label, input, before, candidate, unwrap }) {
  const snapshot = structuredClone(input)
  const expected = before(input)
  assert.equal(unwrap(candidate(input)), expected, `行为不变：${label} 算出的数与改动前不同`)
  assert.deepEqual(input, snapshot, `行为不变：${label} 改动了入参`)
  return expected
}
