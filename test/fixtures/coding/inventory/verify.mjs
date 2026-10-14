import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertPreserved, generated, integer, loadPristine, pick } from '../_shared/refactor.mjs'

const load = name => import(pathToFileURL(path.join(process.argv[2], 'src', name)).href)
const { calculateOrder } = await load('order.mjs')
const { formatOrder } = await load('receipt.mjs')
// 行为不变的参照物是**改动前的那一份**，从 fixture 目录加载（工作区之外，agent 改不到它的那一份）。
const [before] = await loadPristine(import.meta.url, 'order.mjs')

// SKU 只用普通名字。`Object.prototype` 上的名字（`toString` 之类）改动前后**确实不同**：原实现按
// `catalog[sku] ?? 0` 取到继承来的那个函数、算出 NaN，参考实现改用 `Object.hasOwn` 之后把它归进 missing。
// 那是本任务没点名的行为变化，把这类输入放进「不变」那一段会让参考解自己判不过。它如实记在 CHANGES 里，
// 不因此改判据——判据管的是任务点名的那两处，不动它的范围。
const known = ['a', 'b', 'c', 'd', 'e']
const unknown = ['x', 'y', 'z']
const orders = [
  { lines: [{ sku: 'a', quantity: 2 }, { sku: 'x', quantity: 1 }, { sku: 'b', quantity: 3 }, { sku: 'y', quantity: 2 }], catalog: { a: 2.5, b: 1 } },
  { lines: [], catalog: { a: 1 } },
  { lines: [{ sku: 'a', quantity: 0 }, { sku: 'a', quantity: 2 }], catalog: { a: 10 } },
  { lines: [{ sku: 'x', quantity: 3 }], catalog: { a: 1 } },
  { lines: [{ sku: 'a', quantity: 1 }], catalog: {} },
  // 边界用例逐条列全，其余从一片固定的输入空间里生成（理由同 interface）。
  ...generated(0x392, 200, next => {
    const catalog = {}
    for (const sku of known) if (next() < 0.7) catalog[sku] = integer(next, 500) / 100
    const lines = Array.from({ length: integer(next, 5) }, () => ({ sku: pick(next, known), quantity: integer(next, 4) }))
    // 未知 SKU 每个**最多出现一次**：同一个未知 SKU 重复出现时 `missing` 该不该去重，任务说明没有规定，
    // 参考实现按出现次数重复列出。凭空规定一个读法会把另一种同样合理的写法判成错，因此生成的用例避开这一处。
    for (const sku of unknown) if (next() < 0.35) lines.push({ sku, quantity: integer(next, 4) })
    return { lines, catalog }
  }),
]
for (const input of orders) {
  // 段 1（行为不变）：`total` 的数值与纯度照旧。它在**初始态与参考态上都成立**。
  // `total` 能与改动前相等，靠的是「未知 SKU 在两边的贡献都是 0」——原实现算 `(catalog[sku] ?? 0) * qty`，
  // 参考实现只对已知 SKU 累加。这一条正是这次重构真正的行为不变声明，因此由**差分**来钉，而不是在这里把
  // 那套算术重写一遍——重写出来的期望一旦与参考解一起改，就再也测不出「它有没有变」。
  const total = assertPreserved({
    label: 'calculateOrder', input, before: order => before.calculateOrder(order.lines, order.catalog),
    candidate: order => calculateOrder(order.lines, order.catalog), unwrap: value => typeof value === 'number' ? value : value.total,
  })
  // 段 2（新接口）：任务点名要改的那两处。它只在参考态成立。
  const snapshot = structuredClone(input)
  const missing = input.lines.filter(line => !Object.hasOwn(input.catalog, line.sku)).map(line => line.sku)
  assert.deepEqual(calculateOrder(input.lines, input.catalog), { total, missing }, '新接口：calculateOrder 必须返回 { total, missing }')
  assert.equal(formatOrder(input.lines, input.catalog), `Total: ${total.toFixed(2)}; missing: ${missing.join(',') || 'none'}`, '新接口：formatOrder 必须按出现顺序列出缺货 SKU')
  assert.deepEqual(input, snapshot, '新接口：调用之后入参必须原封不动')
}
console.log('acceptance passed: inventory')
