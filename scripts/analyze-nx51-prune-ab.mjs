#!/usr/bin/env node
// NX-51：只读比较 prune-on / prune-off 两批已经落盘的 runs.jsonl。
// 不读取 .env、不调用模型、不改写证据。用法：
//   node scripts/analyze-nx51-prune-ab.mjs <prune-on-dir> <prune-off-dir>
import fs from 'node:fs'
import path from 'node:path'

const [onDir, offDir] = process.argv.slice(2)
if (!onDir || !offDir) throw new Error('usage: analyze-nx51-prune-ab.mjs <prune-on-dir> <prune-off-dir>')

const read = directory => fs.readFileSync(path.join(directory, 'runs.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
const reliable = row => row.status === 'completed' && row.accepted === true && row.acceptanceGroups.length === 4 &&
  row.acceptanceGroups.every(group => group.passed) && !row.protectedFilesChanged.length && row.evidenceComplete
const key = row => `${row.taskId}/${row.repeat}`
const fields = ['mainRequests', 'summaryRequests', 'summaryDurationMs', 'summaryTokens', 'toolCalls', 'toolErrors',
  'inputTokens', 'outputTokens', 'providerTokens', 'activeDurationMs', 'pressureCompactions', 'previewTruncations']
const total = (rows, field) => rows.reduce((sum, row) => sum + (row.metrics[field] ?? 0), 0)
const summarize = rows => Object.fromEntries([
  ['episodes', rows.length], ['reliable', rows.filter(reliable).length], ['accepted', rows.filter(row => row.accepted === true).length],
  ...fields.map(field => [field, total(rows, field)]),
])

const on = read(onDir), off = read(offDir)
const onBy = new Map(on.map(row => [key(row), row])), offBy = new Map(off.map(row => [key(row), row]))
const paired = [...offBy.keys()].sort().map(pair => {
  const before = offBy.get(pair), after = onBy.get(pair)
  if (!before || !after) throw new Error(`missing pair ${pair}`)
  return {
    pair,
    reliable: { off: reliable(before), on: reliable(after) },
    delta: Object.fromEntries(['summaryRequests', 'summaryDurationMs', 'activeDurationMs', 'outputTokens', 'providerTokens', 'mainRequests']
      .map(field => [field, after.metrics[field] - before.metrics[field]])),
  }
})
console.log(JSON.stringify({ onDir, offDir, arms: { off: summarize(off), on: summarize(on) }, paired }, null, 2))
