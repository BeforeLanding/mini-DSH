import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { auditRecords } from './src/audit.mjs'

const records = readFileSync(new URL('./data/records.jsonl', import.meta.url), 'utf8').trim().split('\n').map(line => JSON.parse(line))
// 只有这一条断言：失败输出是一行 AssertionError，指不出是哪条记录、哪个字段不一致。要看细节去跑 report.mjs。
assert.equal(auditRecords(records).length, 0)
// 反向断言，防止「让 auditRecords 恒返回空数组」把上面那条变成空断言。它只用任务说明已经写死的「三个字段
// 缺一不可」，不泄露 name / email / amount 各自的规范形式。
assert.ok(auditRecords([{ id: 'probe' }]).length >= 1)
console.log('public checks passed')
