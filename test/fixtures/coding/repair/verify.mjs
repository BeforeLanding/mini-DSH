import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const { total } = await import(pathToFileURL(path.join(process.argv[2], 'src/cart.mjs')).href)
// 取值域与公开检查 check.mjs 不相交：只针对那三个取值特判的候选在这里过不去。
// 期望值全部选在二进制可精确表示的位置（或落在取整后精确的位置），避免浮点尾差把正确实现判成失败。
const cases = [
  [[], 15, 0],
  [[{ price: 8, quantity: 1 }], 25, 6],
  [[{ price: 10, quantity: 1 }], 0, 10],
  [[{ price: 10, quantity: 1, discount: 1 }], 0, 0],
  [[{ price: 2.5, quantity: 4 }], 12.5, 8.75],
  [[{ price: 6, quantity: 2 }], 75, 3],
  [[{ price: 5, quantity: 1, discount: 0.5 }, { price: 2, quantity: 2 }], 50, 3.25],
  [[{ price: 3, quantity: 2 }, { price: 3, quantity: 2, discount: 0 }], 0, 12],
  // 未被公开检查覆盖的取整用例：3.33 × 0.85 = 2.8305，不取整的实现会在这里失败。
  [[{ price: 1.11, quantity: 3 }], 15, 2.83],
]
for (const [items, percentOff, expected] of cases) {
  assert.equal(total(items, percentOff), expected, `total(${JSON.stringify(items)}, ${percentOff})`)
}
console.log('acceptance passed: repair')
