import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { SessionRuntime } from '../src/core/session-runtime.js'
import { inspectSession, formatInspect } from '../src/core/session-inspect.js'

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-inspect space-'))
  const file = path.join(directory, 'events.jsonl')
  const runtime = new SessionRuntime()
  const session = runtime.create()
  const save = async (suffix = '') => fs.writeFile(file, session.events.map(event => JSON.stringify(event) + '\n').join('') + suffix)
  return { directory, file, runtime, session, save }
}

test('inspect counts dispatch, summary cache, missing usage, stops and multiple runs without writing', async () => {
  const f = await fixture()
  try {
    f.runtime.append(f.session.id, 'context/snapshot', { name: 'runtime:environment', text: 'private clock', source: 'legacy-current' })
    f.runtime.append(f.session.id, 'context/snapshot', { name: 'project:context', text: 'private rules', source: 'legacy-current' })
    const first = f.runtime.beginRun(f.session.id, {}, 'offline')
    const scope = { taskId: first.taskId, runId: first.runId }
    f.runtime.append(f.session.id, 'context/summary-start', { trigger: 'pressure', budgetTokens: 10, projectedTokens: 20, plannedStart: 1, plannedEnd: 2, plannedNodes: 1 }, first)
    f.runtime.append(f.session.id, 'model/start', { ...scope, requestId: 'summary' }, first)
    f.runtime.append(f.session.id, 'model/usage', { ...scope, requestId: 'summary', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, cacheReadTokens: 7, source: 'provider', uncertain: false } }, first)
    f.runtime.append(f.session.id, 'context/summary-end', { startSeq: 5, outcome: { kind: 'declined', reason: 'summary-not-smaller' } }, first)
    f.runtime.append(f.session.id, 'model/start', { ...scope, requestId: 'main' }, first)
    f.runtime.append(f.session.id, 'model/usage', { ...scope, requestId: 'main', usage: { inputTokens: 30, outputTokens: 4, totalTokens: 34, cacheReadTokens: 0, source: 'provider', uncertain: false } }, first)
    f.runtime.append(f.session.id, 'model/start', { ...scope, requestId: 'rejected' }, first)
    f.runtime.append(f.session.id, 'model/rejected', { requestId: 'rejected', reason: 'amount_limit' }, first)
    f.runtime.append(f.session.id, 'tool/start', { ...scope, toolCallId: 'read', name: 'read_history' }, first)
    f.runtime.append(f.session.id, 'tool/result', { toolCallId: 'read', name: 'read_history', content: 'private tool result', isError: false, previewTruncated: true }, first)
    f.runtime.append(f.session.id, 'tool/start', { ...scope, toolCallId: 'bad', name: 'run_command' }, first)
    f.runtime.append(f.session.id, 'tool/result', { toolCallId: 'bad', name: 'run_command', content: 'private error', isError: true }, first)
    f.runtime.finishRun(first, 'completed')
    const second = f.runtime.beginRun(f.session.id, {}, 'offline')
    f.runtime.append(f.session.id, 'model/start', { taskId: second.taskId, runId: second.runId, requestId: 'unknown-usage' }, second)
    f.runtime.finishRun(second, 'token_budget')
    await f.save()
    const before = hash(await fs.readFile(f.file))
    const report = await inspectSession(f.file)
    assert.equal(hash(await fs.readFile(f.file)), before)
    assert.equal(report.integrity.complete, true)
    assert.equal(report.session.runs, 2)
    assert.equal(report.latestRun?.status, 'token_budget')
    assert.deepEqual(report.requests, { main: 2, summary: 1, retries: 0, preDispatchRejected: 1, preparedUnsent: 0, missingUsage: 1, estimatedUsage: 0 })
    assert.deepEqual(report.providerUsage, { inputTokens: 40, outputTokens: 6, cacheReadTokens: 7, cacheReadFieldMissing: 0 })
    assert.equal(report.tools.calls, 2)
    assert.equal(report.tools.confirmedErrors, 1)
    assert.equal(report.mechanisms.historyReads, 1)
    assert.equal(report.mechanisms.compactionAttempts, 1)
    assert.equal(report.frozenSnapshots.legacyCurrentRecorded, 2)
    assert.doesNotMatch(formatInspect(report), /private/)
    const traced = await inspectSession(f.file, { trace: true })
    assert.ok(traced.trace?.events.some(event => event.type === 'tool/start' && event.detail === 'read_history'))
    assert.ok(traced.trace?.events.some(event => event.type === 'run/finish' && event.detail === 'token_budget'))
    assert.doesNotMatch(JSON.stringify(traced), /private clock|private rules|private tool result|private error/)
    assert.doesNotMatch(formatInspect(traced), /private/)
    const traceCli = spawnSync(process.execPath, ['dist/src/index.js', 'inspect', f.file, '--trace'], { encoding: 'utf8', env: { ...process.env, DEEPSEEK_API_KEY: '' } })
    assert.equal(traceCli.status, 0, traceCli.stderr)
    assert.match(traceCli.stdout, /#\d+ tool\/start read_history/)
    assert.doesNotMatch(traceCli.stdout, /private/)
    const cli = spawnSync(process.execPath, ['dist/src/index.js', 'inspect', f.file, '--json'], { encoding: 'utf8', env: { ...process.env, DEEPSEEK_API_KEY: '', MINI_DSH_SESSION_DIR: path.join(f.directory, 'must-not-create') } })
    assert.equal(cli.status, 0, cli.stderr)
    assert.equal(JSON.parse(cli.stdout).providerUsage.cacheReadTokens, 7)
    assert.equal(hash(await fs.readFile(f.file)), before)
    await assert.rejects(fs.stat(path.join(f.directory, 'must-not-create')))
  } finally { await fs.rm(f.directory, { recursive: true, force: true }) }
})

test('trace is bounded to recent metadata, including JSON mode', async () => {
  const f = await fixture()
  try {
    for (let index = 0; index < 50; index++) f.runtime.append(f.session.id, 'context/projection', { estimatedInputTokens: index, reservedOutputTokens: 1, safetyMarginTokens: 0, removedTaskIds: [] })
    await f.save()
    const report = await inspectSession(f.file, { trace: true })
    assert.equal(report.trace?.events.length, 40)
    assert.equal(report.trace?.truncated, true)
    assert.equal(report.trace?.events[0]?.seq, 12)
    const cli = spawnSync(process.execPath, ['dist/src/index.js', 'inspect', f.file, '--json', '--trace'], { encoding: 'utf8', env: { ...process.env, DEEPSEEK_API_KEY: '' } })
    assert.equal(cli.status, 0, cli.stderr)
    assert.equal(JSON.parse(cli.stdout).trace.events.length, 40)
  } finally { await fs.rm(f.directory, { recursive: true, force: true }) }
})

test('inspect reports partial evidence and distinguishes tail, JSON, unknown event and unrecorded end', async () => {
  const f = await fixture()
  try {
    const run = f.runtime.beginRun(f.session.id, {}, 'offline')
    f.runtime.append(f.session.id, 'model/start', { taskId: run.taskId, runId: run.runId, requestId: 'dispatched' }, run)
    await f.save()
    assert.equal((await inspectSession(f.file)).latestRun?.status, 'unrecorded_end')
    await f.save('{')
    let report = await inspectSession(f.file)
    assert.equal(report.integrity.complete, false)
    assert.equal(report.integrity.warnings[0]?.code, 'truncated_tail')
    assert.equal(report.requests.missingUsage, 1)
    await f.save('{bad}\n')
    report = await inspectSession(f.file)
    assert.equal(report.integrity.warnings[0]?.code, 'corrupt_json')
    assert.equal(report.integrity.warnings[0]?.line, f.session.events.length + 1)
    const unknown = { ...f.session.events.at(-1), seq: f.session.events.length + 1, id: 'unknown-id', type: 'unknown/event' }
    await f.save(JSON.stringify(unknown) + '\n')
    report = await inspectSession(f.file)
    assert.equal(report.integrity.warnings[0]?.code, 'unknown_event_type')
    const cli = spawnSync(process.execPath, ['dist/src/index.js', 'inspect', f.file, '--json'], { encoding: 'utf8', env: { ...process.env, DEEPSEEK_API_KEY: '' } })
    assert.equal(cli.status, 2)
    assert.equal(JSON.parse(cli.stdout).integrity.complete, false)
  } finally { await fs.rm(f.directory, { recursive: true, force: true }) }
})

test('inspect handles repeated summaries, omitted cache field, prepared but unsent projection, and reset snapshot epoch', async () => {
  const f = await fixture()
  try {
    const run = f.runtime.beginRun(f.session.id, {}, 'offline')
    const scope = { taskId: run.taskId, runId: run.runId }
    for (let index = 0; index < 2; index++) {
      const start = f.runtime.append(f.session.id, 'context/summary-start', { trigger: 'pressure', budgetTokens: 10, projectedTokens: 20, plannedStart: 1, plannedEnd: 2, plannedNodes: 1 }, run)
      const requestId = `summary-${index}`
      f.runtime.append(f.session.id, 'model/start', { ...scope, requestId }, run)
      f.runtime.append(f.session.id, 'model/usage', { ...scope, requestId, usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6, source: 'provider', uncertain: false, ...(index === 0 ? { cacheReadTokens: 0 } : {}) } }, run)
      f.runtime.append(f.session.id, 'context/summary-end', { startSeq: start.seq, outcome: { kind: 'declined', reason: 'summary-not-smaller' } }, run)
    }
    f.runtime.append(f.session.id, 'context/projection', { requestId: 'never-dispatched', estimatedInputTokens: 12, reservedOutputTokens: 4, safetyMarginTokens: 1, removedTaskIds: [] }, run)
    f.runtime.finishRun(run, 'token_budget')
    await f.save()
    const report = await inspectSession(f.file)
    assert.equal(report.requests.summary, 2)
    assert.equal(report.requests.main, 0)
    assert.equal(report.requests.preparedUnsent, 1)
    assert.equal(report.providerUsage.inputTokens, 10)
    assert.equal(report.providerUsage.cacheReadTokens, 0)
    assert.equal(report.providerUsage.cacheReadFieldMissing, 1)
    assert.equal(report.mechanisms.compactionAttempts, 2)
    f.runtime.clear(f.session.id)
    f.runtime.append(f.session.id, 'context/snapshot', { name: 'runtime:environment', text: 'new clock', source: 'new-session' })
    await f.save()
    assert.deepEqual((await inspectSession(f.file)).frozenSnapshots.currentEpoch, { runtime: 'new-session', project: null })
  } finally { await fs.rm(f.directory, { recursive: true, force: true }) }
})
