import { readFileSync } from 'node:fs'
import { auditRecords } from './src/audit.mjs'

const records = readFileSync(new URL('./data/records.jsonl', import.meta.url), 'utf8').trim().split('\n').map(line => JSON.parse(line))

// 每种字段的规范形式。报告把它和原始值、期望值一起打出来，因此不必先读源码就能知道「哪里不对、应该是什么」。
const RULES = {
  name: '去掉首尾空白，并把中间的连续空白折叠成一个空格',
  email: '去掉首尾空白，并转为小写',
  amount: '保留两位小数的十进制字符串',
}

const violations = auditRecords(records)
const counts = new Map()
for (const [index, violation] of violations.entries()) {
  counts.set(violation.field, (counts.get(violation.field) ?? 0) + 1)
  console.log(`[${String(index + 1).padStart(4, '0')}/${violations.length}] VIOLATION id=${violation.id} field=${violation.field}`)
  console.log(`  record   : ${JSON.stringify(violation.record)}`)
  console.log(`  actual   : ${JSON.stringify(violation.actual)}`)
  console.log(`  expected : ${JSON.stringify(violation.expected)}`)
  console.log(`  rule     : ${violation.field} 的规范形式是${RULES[violation.field] ?? '（未知字段）'}。`)
  console.log(`  ${'-'.repeat(96)}`)
}
console.log(`SUMMARY ${violations.length}`)
for (const [field, count] of [...counts].sort()) console.log(`KIND ${field} ${count}`)
