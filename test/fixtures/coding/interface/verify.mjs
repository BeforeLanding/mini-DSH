import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertPreserved, generated, integer, loadPristine } from '../_shared/refactor.mjs'

const load = name => import(pathToFileURL(path.join(process.argv[2], 'src', name)).href)
const { calculateSubtotal } = await load('pricing.mjs')
const { formatReceipt } = await load('receipt.mjs')
// 行为不变的参照物是**改动前的那一份**，从 fixture 目录加载（工作区之外，agent 改不到它的那一份）。
const [before] = await loadPristine(import.meta.url, 'pricing.mjs')

const currency = 'CNY'
const items = [
  [],
  [{ price: 6.25, quantity: 2 }],
  [{ price: 3, quantity: 4 }, { price: 0.5, quantity: 3 }],
  [{ price: 10, quantity: 0 }],
  [{ price: 0, quantity: 3 }, { price: 0.05, quantity: 7 }, { price: 1234.56, quantity: 2 }],
  // 边界用例逐条列全（空、单条、多条、quantity 为 0、进位敏感的小数），其余从一片固定的输入空间里生成。
  // 生成而不是只钉那几条：只钉几条的话，一份「把这几条背下来」的实现照样能过，而这个 fixture 问的是
  // 「改动有没有动到不该动的地方」——那是对**所有**输入说的。
  ...generated(0x391, 200, next => Array.from({ length: integer(next, 5) }, () => ({ price: integer(next, 20000) / 100, quantity: integer(next, 4) }))),
]
for (const input of items) {
  // 段 1（行为不变）：数照旧、入参照旧不被改动。这一段在**初始态与参考态上都成立**——它就是「重构」这个词
  // 的定义，也是门禁用来分辨「改动破坏了行为」与「改动还没做完」的那一半。
  const amount = assertPreserved({
    label: 'calculateSubtotal', input, before: before.calculateSubtotal, candidate: calculateSubtotal,
    unwrap: value => typeof value === 'number' ? value : value.amount,
  })
  // 段 2（新接口）：任务点名要改的那两处。它只在参考态成立。
  // 期望的**数**直接用段 1 返回的那个，不在这里重算一遍——重算就是在同一处再写一次期望，两处迟早漂开。
  const snapshot = structuredClone(input)
  assert.deepEqual(calculateSubtotal(input), { amount, currency }, '新接口：calculateSubtotal 必须返回 { amount, currency }')
  assert.equal(formatReceipt(input), `${currency} ${amount.toFixed(2)}`, '新接口：formatReceipt 必须输出「币种 + 两位小数」')
  assert.deepEqual(input, snapshot, '新接口：调用之后入参必须原封不动')
}
console.log('acceptance passed: interface')
