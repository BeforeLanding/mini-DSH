import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CompactionRuntime } from '../src/core/compaction-runtime.js'
import { parseLog } from '../src/core/event-store.js'
import { ProviderError } from '../src/core/model-error.js'
import { inspectSession, formatInspect } from '../src/core/session-inspect.js'
import { SessionRuntime } from '../src/core/session-runtime.js'
import { createDeepSeekAdapter } from '../src/models/deepseek.js'
import { harness } from './harness.js'

test('provider failure writes one safe run/error, preserves the unique terminal, and restores from JSONL', async () => {
  const h = harness(async () => { throw new ProviderError('auth', 401, false, 'request-1') })
  await assert.rejects(h.agent.send('synthetic request'), /authentication failed/)
  const errors = h.session.events.filter(event => event.type === 'run/error')
  assert.equal(errors.length, 1)
  assert.equal(errors[0]!.data.stage, 'model')
  assert.equal(errors[0]!.data.errorKind, 'auth')
  assert.equal(errors[0]!.data.httpStatus, 401)
  assert.ok(errors[0]!.data.requestId)
  assert.equal(h.session.events.filter(event => event.type === 'run/finish').length, 1)
  const jsonl = h.session.events.map(event => JSON.stringify(event) + '\n').join('')
  assert.deepEqual(parseLog(jsonl, h.session.id), h.session.events)
  const restored = new SessionRuntime()
  await restored.restore({ read: async () => structuredClone(h.session.events), append: async () => {}, close: async () => {} })
  assert.equal(restored.latestRun(h.session.id)?.status, 'error')
  assert.equal(restored.get(h.session.id).events.filter(event => event.type === 'run/error').length, 1)
})

test('inspect v2 shows recorded safe cause, reads legacy logs, and rejects unsafe error payloads', async () => {
  const secret = 'fake-secret-token-for-r01'
  const adapter = createDeepSeekAdapter({ apiKey: 'mock', fetch: async () => new Response(`rate limited: ${secret}`, { status: 429 }) })
  const h = harness(request => adapter.chat(request))
  await assert.rejects(h.agent.send('synthetic'), /rate limit reached/)
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-run-error-'))
  try {
    const file = path.join(directory, 'events.jsonl')
    const jsonl = h.session.events.map(event => JSON.stringify(event) + '\n').join('')
    await fs.writeFile(file, jsonl)
    const report = await inspectSession(file, { trace: true })
    assert.equal(report.version, 2)
    assert.equal(report.errors.count, 1)
    assert.equal(report.errors.last?.errorKind, 'rate_limit')
    assert.match(formatInspect(report), /Provider rate limit reached/)
    assert.doesNotMatch(JSON.stringify(report) + formatInspect(report) + jsonl, /fake-secret-token/)
    const oldRuntime = new SessionRuntime(), oldSession = oldRuntime.create()
    const oldRun = oldRuntime.beginRun(oldSession.id, {}, 'offline')
    oldRuntime.finishRun(oldRun, 'error')
    await fs.writeFile(file, oldSession.events.map(event => JSON.stringify(event) + '\n').join(''))
    const legacy = await inspectSession(file)
    assert.equal(legacy.integrity.complete, true)
    assert.equal(legacy.errors.count, 0)
    assert.match(formatInspect(legacy), /unknown \(legacy or interrupted log\)/)
    await fs.appendFile(file, '{bad}\n')
    assert.equal((await inspectSession(file)).integrity.warnings[0]?.code, 'corrupt_json')
    const unsafe = structuredClone(h.session.events)
    const error = unsafe.find(event => event.type === 'run/error')!
    if (error.type !== 'run/error') throw new Error('missing run/error')
    error.data.safeMessage = secret
    assert.throws(() => parseLog(unsafe.map(event => JSON.stringify(event) + '\n').join(''), h.session.id), /invalid event payload/)
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('summary failure and tool exception have separate safe stages and tool protocol remains paired', async () => {
  const h = harness(async request => {
    if (request.purpose === 'summary') throw new ProviderError('rate_limit', 429, true)
    return { content: 'done', complete: true }
  })
  const run = h.sessions.beginRun(h.session.id, { contextWindowTokens: 1_000_000, inputTargetTokens: 65_536, maxOutputTokens: 16_384 }, 'mock/test')
  h.sessions.append(h.session.id, 'user/message', { content: 'original request' }, run)
  h.sessions.append(h.session.id, 'assistant/message', { content: 'working' }, run)
  h.sessions.append(h.session.id, 'assistant/tool_calls', { toolCalls: [{ id: 'read-1', name: 'read_file', arguments: {} }] }, run)
  h.sessions.append(h.session.id, 'tool/result', { toolCallId: 'read-1', name: 'read_file', content: 'x'.repeat(4000) }, run)
  h.sessions.append(h.session.id, 'assistant/message', { content: 'tail' }, run)
  const compaction = new CompactionRuntime({ sessions: h.sessions, llm: h.llm })
  assert.deepEqual(await compaction.compact({ sessionId: h.session.id, state: run, trigger: 'explicit', budgetTokens: 65_536, projectedTokens: 60_000,
    retainRatio: 0.1, maxSummaryTokens: 8192, system: 'system', tools: [], model: 'mock/test', signal: new AbortController().signal,
    check: () => {}, outputAllowance: () => 8192 }), { kind: 'declined', reason: 'summary-failed' })
  const summary = h.session.events.find(event => event.type === 'run/error')
  assert.equal(summary?.type === 'run/error' && summary.data.stage, 'summary')
  assert.equal(summary?.type === 'run/error' && summary.data.errorKind, 'rate_limit')

  let calls = 0
  const tools = harness(async () => ++calls === 1 ? { toolCalls: [{ id: 'tool-1', name: 'broken', arguments: {} }] } : { content: 'done' })
  tools.tools.register({ name: 'broken', execute: () => { throw new Error('fake-secret-token-in-tool-error') } })
  assert.equal(await tools.agent.send('use the tool'), 'done')
  const toolErrors = tools.session.events.filter(event => event.type === 'run/error')
  assert.equal(toolErrors.length, 1)
  assert.equal(toolErrors[0]!.data.stage, 'tool')
  assert.equal(toolErrors[0]!.data.safeMessage, 'Tool call failed')
  assert.equal(tools.session.events.filter(event => event.type === 'tool/result' && event.data.toolCallId === 'tool-1').length, 1)
  assert.equal(tools.session.events.filter(event => event.type === 'run/finish').length, 1)
  assert.doesNotMatch(JSON.stringify(tools.session.events), /fake-secret-token-in-tool-error/)
})
