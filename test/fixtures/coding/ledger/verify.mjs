import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// 独立验收：只从工作区读实现与流水，判据本身留在本文件里——工作区里没有同一份副本。整个脚本只打印一行
// 标记，与其它 fixture 的验收器同一约定。
const root = process.argv[2]
const load = name => import(pathToFileURL(path.join(root, 'src', name)).href)
const { parseJournal } = await load('parse.mjs')
const { summarize } = await load('summarize.mjs')
const { renderLedger } = await load('render.mjs')
const { checksum } = await load('checksum.mjs')

const text = fs.readFileSync(path.join(root, 'data', 'journal.tsv'), 'utf8')
const { entries, skipped } = parseJournal(text)

assert.equal(entries.length, 13, 'entry count')
// 表头（第 1 行）与空行（第 10 行）都不算。三行坏行各自对应一种拒绝理由：第 14 行金额 `12` 不是两位
// 小数、第 17 行只有两个字段、第 18 行 `2026-02-30` 是不存在的日期（形状对、日历上没有）。
assert.deepEqual(skipped, [14, 17, 18], 'skipped line numbers')
assert.equal(entries[0].amount, '1200.00', 'amount must stay the source string')
assert.equal(entries.at(-1).id, 'j-013', 'entries keep the order of the file')

const rows = summarize(entries)
assert.deepEqual(rows.map(row => [row.account, row.total, row.count]), [
  ['cogs', 72000, 3],
  ['freight', 11029, 3],
  ['refund', -44025, 2],
  ['revenue', 403625, 5],
], 'summary rows')

const rendered = renderLedger(rows, { source: 'data/journal.tsv', entries })
const lines = rendered.split('\n')
assert.equal(lines.at(-1), '', 'the ledger text must end with a newline')
assert.deepEqual(lines.slice(0, 6), [
  'source: data/journal.tsv',
  'rows: 4',
  '  cogs 72000 3',
  '  freight 11029 3',
  '  refund -44025 2',
  '  revenue 403625 5',
], 'ledger body does not match SPEC section 3')

// 校验和是唯一一条工作区里没有副本的判据，因此必须单独断言、单独报错：与上面那条格式断言合在一起，
// 「口径没接上」会被读成「文本格式不对」，失败的归因就丢了。
assert.equal(checksum(entries), 550679, 'checksum does not follow the agreed reconciliation basis')
assert.equal(lines[6], 'checksum: 550679', 'the rendered checksum line must carry the agreed value')

console.log('acceptance passed: ledger')
