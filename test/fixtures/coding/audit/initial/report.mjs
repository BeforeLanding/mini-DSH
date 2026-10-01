import { readFileSync } from 'node:fs'
import { auditRecords } from './src/audit.mjs'

const records = readFileSync(new URL('./data/records.jsonl', import.meta.url), 'utf8').trim().split('\n').map(line => JSON.parse(line))

// 报告只逐条打印「原始记录 / 当前的规整结果 / 规范值」三元组，不复述规范形式本身：规范形式要靠这三者
// 的对照自己读出来。把散文规则写进这个文件会让「读一遍源码」等价于「跑一遍报告」，那样报告的最大输出
// 就成了纯装饰——实测确认过这一点（NX-08f-4b），因此这里刻意不写。
const violations = auditRecords(records)
const counts = new Map()
for (const [index, violation] of violations.entries()) {
  counts.set(violation.field, (counts.get(violation.field) ?? 0) + 1)
  console.log(`[${String(index + 1).padStart(4, '0')}/${violations.length}] VIOLATION id=${violation.id} field=${violation.field}`)
  console.log(`  record   : ${JSON.stringify(violation.record)}`)
  console.log(`  actual   : ${JSON.stringify(violation.actual)}`)
  console.log(`  expected : ${JSON.stringify(violation.expected)}`)
  console.log(`  ${'-'.repeat(96)}`)
}
console.log(`SUMMARY ${violations.length}`)
for (const [field, count] of [...counts].sort()) console.log(`KIND ${field} ${count}`)
