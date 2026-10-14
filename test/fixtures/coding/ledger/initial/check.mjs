import assert from 'node:assert/strict'
import { parseJournal } from './src/parse.mjs'
import { summarize } from './src/summarize.mjs'
import { renderLedger } from './src/render.mjs'
import { checksum } from './src/checksum.mjs'

// 公开检查按阶段累积：`node check.mjs 4` 会重跑第 1 到第 4 阶段的全部断言，后面的阶段还没实现也能跑。
// 第 3 阶段的渲染检查只看格式，**不比对校验和的数值**——那个口径不在本仓库里（见 docs/SPEC.md 第 4 节），
// 公开检查手上没有第二份判据，也不该假装有。第 4 阶段因此只查性质（整数、稳定、对金额敏感）。
const sample = [
  'id\tdate\taccount\tamount\tcustomer',
  'a-1\t2026-09-01\trev\t10.00\t甲',
  'a-2\t2026-09-01\trev\t-2.50\t乙',
  '',
  'broken\t2026-09-02\trev\t1.5\t丙',
  'a-3\t2026-09-03\tcog\t40.00\t丁',
  'a-4\t2026-02-30\tcog\t5.00\t戊',
].join('\n')

const stages = [
  () => {
    const { entries, skipped } = parseJournal(sample)
    assert.deepEqual(entries, [
      { id: 'a-1', date: '2026-09-01', account: 'rev', amount: '10.00', customer: '甲' },
      { id: 'a-2', date: '2026-09-01', account: 'rev', amount: '-2.50', customer: '乙' },
      { id: 'a-3', date: '2026-09-03', account: 'cog', amount: '40.00', customer: '丁' },
    ])
    // 表头是第 1 行、空行是第 4 行，两者都不进 skipped；坏行是第 5 行（amount 只有一位小数）与第 7 行
    // （`2026-02-30`——形状是日期，日历上不存在）。
    assert.deepEqual(skipped, [5, 7])
  },
  () => {
    assert.deepEqual(summarize(parseJournal(sample).entries), [
      { account: 'cog', total: 4000, count: 1 },
      { account: 'rev', total: 750, count: 2 },
    ])
    assert.deepEqual(summarize([]), [])
  },
  () => {
    const { entries } = parseJournal(sample)
    const lines = renderLedger(summarize(entries), { source: 'sample.tsv', entries }).split('\n')
    assert.deepEqual(lines.slice(0, 4), ['source: sample.tsv', 'rows: 2', '  cog 4000 1', '  rev 750 2'])
    assert.match(lines[4], /^checksum: \d+$/)
    assert.equal(lines[5], '')
  },
  () => {
    const { entries } = parseJournal(sample)
    const value = checksum(entries)
    assert.ok(Number.isSafeInteger(value), 'checksum must return an integer')
    assert.equal(checksum([]), 0)
    assert.equal(checksum(entries), value, 'the same entries must give the same checksum')
    assert.notEqual(checksum(parseJournal(sample.replace('10.00', '11.00')).entries), value)
  },
]

const requested = process.argv[2] === undefined ? stages.length : Number(process.argv[2])
if (!Number.isSafeInteger(requested) || requested < 1 || requested > stages.length) {
  throw new Error(`stage must be an integer between 1 and ${stages.length}`)
}
for (const stage of stages.slice(0, requested)) stage()
console.log('public checks passed')
