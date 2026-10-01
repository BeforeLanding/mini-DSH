import assert from 'node:assert/strict'
import { total } from './src/cart.mjs'
assert.equal(total([{ price: 10, quantity: 2, discount: 0.5 }], 0), 10, '单项折扣应按行金额在求和前应用（见 src/AGENTS.md）')
assert.equal(total([{ price: 10, quantity: 1 }], 15), 8.5, 'percentOff 是整数百分数：15 表示 15%')
assert.equal(total([{ price: 1.05, quantity: 3 }], 15), 2.68, '总额应四舍五入到 2 位小数')
console.log('public checks passed')
