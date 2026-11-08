import assert from 'node:assert/strict'
import { describePeople } from './src/report.mjs'

// 冒烟检查：只覆盖一个例子。完整边界由工作区之外的隐藏验收器判定。
assert.deepEqual(describePeople([{ id: 1, name: ' Ada ' }]), { names: ['ada'], count: 1 })
console.log('public checks passed: report')
