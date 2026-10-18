// Redacted structural audit. No prompt, reasoning, tool result, or command text is emitted.
import fs from 'node:fs'
import path from 'node:path'

const batch = process.argv[2]
if (!batch) throw new Error('usage: node scripts/eval-failure-audit.mjs <batch-directory>')
const runs = fs.readFileSync(path.join(batch, 'runs.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse)
const selected = runs.filter(run => (run.taskId === 'TC01' && run.arm === 'full') || run.taskId === 'RC01')
const results = []
for (const run of selected) {
  const episode = fs.readdirSync(path.join(batch, 'episodes')).find(name => name.endsWith(`-${run.taskId}-${run.repeat}-${run.arm}`))
  const sessionFolder = path.join(batch, 'episodes', episode, 'sessions')
  const session = fs.readdirSync(sessionFolder)[0]
  const file = path.join(sessionFolder, session, 'events.jsonl')
  const events = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).map(JSON.parse)
  const starts = events.filter(event => event.type === 'model/start')
  const usages = new Map(events.filter(event => event.type === 'model/usage').map(event => [event.data.requestId, event]))
  const ends = new Map(events.filter(event => event.type === 'model/end').map(event => [event.data.requestId, event]))
  const summaries = events.filter(event => event.type === 'context/summary-start').map(event => event.seq)
  const summaryEnds = events.filter(event => event.type === 'context/summary-end').map(event => event.seq)
  const calls = events.filter(event => event.type === 'assistant/tool_calls').flatMap(event => event.data.toolCalls.map(call => ({ seq: event.seq, id: call.id, name: call.name, args: call.arguments })))
  const toolStarts = events.filter(event => event.type === 'tool/start')
  const changes = events.filter(event => event.type === 'file/change')
  const checks = events.filter(event => event.type === 'verification/start')
  const requestBuckets = { repair: { requests: 0, tokens: 0 }, verification: { requests: 0, tokens: 0 }, reading: { requests: 0, tokens: 0 }, closing: { requests: 0, tokens: 0 }, other: { requests: 0, tokens: 0 }, summary: { requests: 0, tokens: 0 } }
  const requests = starts.map((start, index) => {
    const next = starts[index + 1]?.seq ?? Infinity
    const usage = usages.get(start.data.requestId)?.data.usage
    const end = ends.get(start.data.requestId)
    const isSummary = summaries.some((seq, i) => seq < start.seq && (summaryEnds[i] ?? Infinity) > start.seq)
    const actionCalls = calls.filter(call => call.seq > start.seq && call.seq < next)
    const names = actionCalls.map(call => call.name)
    const bucket = isSummary ? 'summary' : names.some(name => ['edit_file', 'write_file'].includes(name)) ? 'repair' : names.includes('bash') ? 'verification' : names.some(name => ['read_file', 'read_history', 'read_tool_result', 'grep', 'glob', 'project_context'].includes(name)) ? 'reading' : names.includes('task_report') || names.length === 0 ? 'closing' : 'other'
    requestBuckets[bucket].requests++
    requestBuckets[bucket].tokens += usage?.totalTokens ?? 0
    return { startSeq: start.seq, usageSeq: usages.get(start.data.requestId)?.seq ?? null, endSeq: end?.seq ?? null, complete: end?.data.complete ?? null, finishReason: end?.data.finishReason ?? null, inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null, reasoningTokens: usage?.reasoningTokens ?? null, usageSource: usage?.source ?? 'unknown', bucket }
  })
  const reads = calls.filter(call => ['read_file', 'read_history', 'read_tool_result', 'grep', 'glob'].includes(call.name))
  const readKeys = reads.map(call => JSON.stringify([call.name, call.args]))
  const repeatedReads = readKeys.length - new Set(readKeys).size
  const verificationKeys = checks.map(event => JSON.stringify([event.data.command, event.data.files?.map(file => file.path ?? file).sort(), changes.filter(change => change.seq < event.seq).at(-1)?.seq ?? 0]))
  results.push({ taskId: run.taskId, repeat: run.repeat, arm: run.arm, status: run.status, failureReason: run.failureReason ?? null,
    eventFile: file, requestBuckets, counts: { mainRequests: requests.length - requestBuckets.summary.requests, summaryRequests: requestBuckets.summary.requests, toolStarts: toolStarts.length, fileChanges: changes.length, verificationStarts: checks.length, repeatedIdenticalReadArguments: repeatedReads, repeatedVerificationWithoutInterveningChange: verificationKeys.length - new Set(verificationKeys).size },
    lastRequest: requests.at(-1), ...(run.taskId === 'TC01' ? {} : { requestEvents: requests.map(({ startSeq, endSeq, bucket, inputTokens, outputTokens }) => ({ startSeq, endSeq, bucket, inputTokens, outputTokens })) }),
  })
}
process.stdout.write(`${JSON.stringify({ batch, classification: 'Whole request assigned by following tool action; token buckets are mutually exclusive approximations, not causal attribution. Repeated reads compare exact tool name and arguments only.', results }, null, 2)}\n`)
