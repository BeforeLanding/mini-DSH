import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { readHistory } from '../src/core/history-read.js'
import { CompactionRuntime } from '../src/core/compaction-runtime.js'
import { SessionRuntime } from '../src/core/session-runtime.js'
import * as sessions from '../src/plugins/session.js'
import * as tools from '../src/plugins/tools.js'
import * as sandbox from '../src/plugins/sandbox.js'
import * as toolResults from '../src/plugins/tool-results.js'
import * as readHistoryPlugin from '../src/plugins/read-history.js'
import type { RunState } from '../src/core/budget.js'
import { harness } from './harness.js'

const policy = { contextWindowTokens: 1_000_000, inputTargetTokens: 65_536, maxOutputTokens: 16_384 } as const

const REQUEST = 'original request: fix the cart total'
const CONSTRAINT = 'constraint: never edit src/secret.ts and always run node check.mjs'

// 一条单任务会话：原始请求（恒受保护）之后是一段会被压掉的历史，其中一条 assistant 消息承载了
// 「摘要可能丢掉、但事件号还在」的那种事实。压缩后它就不在投影里了——正是回读要补上的那一段。
function compactedSession() {
  const h = harness(async () => ({ content: 'early range summary' }))
  const run: RunState = h.sessions.beginRun(h.session.id, policy, 'mock/test')
  h.sessions.append(h.session.id, 'user/message', { content: REQUEST }, run)
  h.sessions.append(h.session.id, 'assistant/message', { content: `noted. ${CONSTRAINT}` }, run)
  h.sessions.append(h.session.id, 'assistant/tool_calls', { toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'src/cart.mjs' } }] }, run)
  h.sessions.append(h.session.id, 'tool/result', { toolCallId: 'c1', name: 'read_file', content: 'y'.repeat(4000) }, run)
  h.sessions.append(h.session.id, 'assistant/message', { content: 'tail' }, run)
  const runtime = new CompactionRuntime({ sessions: h.sessions, llm: h.llm })
  return { h, run, runtime }
}

const compact = (h: ReturnType<typeof harness>, run: RunState, runtime: CompactionRuntime) => runtime.compact({
  sessionId: h.session.id, state: run, trigger: 'explicit', budgetTokens: 65_536, projectedTokens: 60_000,
  retainRatio: 0.1, maxSummaryTokens: 8192, system: 'system', tools: [], model: 'mock/test',
  signal: new AbortController().signal, check: () => {}, outputAllowance: () => 8192,
})

const visibleSeqs = (h: ReturnType<typeof harness>) => h.sessions.visibleEvents(h.session.id).map(event => event.seq)

test('a shadowed range reads back verbatim, so a dropped fact is recoverable by event number', async () => {
  const { h, run, runtime } = compactedSession()
  assert.equal((await compact(h, run, runtime)).kind, 'applied')
  const projected = h.sessions.deriveMessages(h.session.id)
  // 原始请求仍然原样在投影里（§7.2 的保护集），承载约束的那条 assistant 消息则被换掉了。
  assert.equal(projected[0]!.content, REQUEST)
  assert.equal(projected.some(message => message.content?.includes(CONSTRAINT)), false)

  const shadowed = h.sessions.visibleEvents(h.session.id).find(event => event.type === 'context/summary')!.data.shadowedSeqs
  const read = readHistory(h.sessions, h.session.id, shadowed[0]!)
  assert.match(read.content, /constraint: never edit src\/secret\.ts and always run node check\.mjs/)
  assert.match(read.content, /y{200}/, '工具结果正文逐字回读')
  // 原始请求也读得回来——它在投影里，但回读不该因此变成另一段历史。
  assert.match(readHistory(h.sessions, h.session.id, visibleSeqs(h)[0]!).content, /original request: fix the cart total/)
  assert.equal(read.eof, true)
  assert.equal(read.nextSeq, visibleSeqs(h).at(-1)! + 1)
  assert.equal(read.totalEvents, visibleSeqs(h).length)
})

test('the read-back pages forward with nextSeq until eof without dropping an event', async () => {
  const { h, run, runtime } = compactedSession()
  await compact(h, run, runtime)
  const first = visibleSeqs(h)[0]!
  const last = visibleSeqs(h).at(-1)!

  const pages: string[] = []
  let from = first
  let guard = 0
  while (guard++ < 50) {
    const page = readHistory(h.sessions, h.session.id, from, last, 200)
    assert.ok(page.content.length > 0, '每一页都必须有内容，否则调用方会卡住')
    pages.push(page.content)
    if (page.eof) break
    assert.ok(page.nextSeq > from, 'nextSeq 必须前进，否则同样的预算会一页页重读同一条事件')
    from = page.nextSeq
  }
  assert.ok(guard < 50, '分页必须收敛')
  const whole = pages.join('\n')
  for (let seq = first; seq <= last; seq++) assert.match(whole, new RegExp(`\\[${seq}\\] `), `第 ${seq} 号事件必须在某一页里出现`)
})

test('an event larger than the whole budget is bounded and says so instead of stalling the page', () => {
  const h = harness(async () => ({ content: 'unused' }))
  const run = h.sessions.beginRun(h.session.id, policy, 'mock/test')
  const huge = h.sessions.append(h.session.id, 'user/message', { content: 'q'.repeat(40_000) }, run).seq

  // 一页绝不在中途把事件劈成两半：装不下整条时停它之前，让下一页从头读它。
  const first = readHistory(h.sessions, h.session.id, 1, undefined, 1024)
  assert.ok(Buffer.byteLength(first.content) <= 1024, '正文绝不超出预算')
  assert.equal(first.eof, false)
  assert.equal(first.nextSeq, huge)
  // 下一页就是从它开头读，仍然装不下：给出有界前缀并**前进**，否则永远走不到 eof。
  const second = readHistory(h.sessions, h.session.id, first.nextSeq, undefined, 1024)
  assert.match(second.content, new RegExp(`\\[event ${huge} truncated; 400\\d\\d bytes total; raise maxBytes to read it whole\\]`))
  assert.equal(second.nextSeq, huge + 1)
  assert.equal(second.eof, true)
  assert.ok(Buffer.byteLength(second.content) <= 1024)
})

test('out-of-range, inverted and malformed requests are refused explicitly', async () => {
  const { h, run, runtime } = compactedSession()
  await compact(h, run, runtime)
  const last = visibleSeqs(h).at(-1)!

  assert.throws(() => readHistory(h.sessions, h.session.id, last + 1), /outside this session history/)
  assert.throws(() => readHistory(h.sessions, h.session.id, 3, 2), /must not be before/)
  for (const bad of [0, -1, 1.5, Number.NaN, '3', undefined]) assert.throws(() => readHistory(h.sessions, h.session.id, bad), /positive safe integer/)
  assert.throws(() => readHistory(h.sessions, h.session.id, 1, undefined, 0), /maxBytes/)
  assert.throws(() => readHistory(h.sessions, h.session.id, 1, undefined, 99 * 1024), /maxBytes/)
})

test('non-message events are listed by type only, and the truncation is stated in the body', () => {
  const h = harness(async () => ({ content: 'unused' }))
  const run = h.sessions.beginRun(h.session.id, policy, 'mock/test')
  h.sessions.append(h.session.id, 'user/message', { content: 'z'.repeat(4000) }, run)
  const read = readHistory(h.sessions, h.session.id, 1, undefined, 200)
  assert.match(read.content, /\[1\] session\/start/)
  assert.match(read.content, /\[truncated; continue with read_history from=\d+\]/)
  assert.equal(read.eof, false)
})

test('two sessions in one runtime never leak into each other', () => {
  const runtime = new SessionRuntime()
  const build = (marker: string) => {
    const session = runtime.create({ marker })
    const run = runtime.beginRun(session.id, {}, 'mock/test')
    runtime.append(session.id, 'user/message', { content: `only in ${marker}` }, run)
    runtime.append(session.id, 'assistant/message', { content: `reply with ${marker}` }, run)
    return session.id
  }
  const alpha = build('alpha')
  const beta = build('beta')

  const read = readHistory(runtime, alpha, 1)
  assert.match(read.content, /only in alpha/)
  assert.doesNotMatch(read.content, /beta/)
  assert.match(readHistory(runtime, beta, 1).content, /only in beta/)
})

test('the Cordis tool requires a session and releases its registration on dispose', async () => {
  const root = new Context()
  try {
    await root.plugin(sessions)
    await root.plugin(tools)
    await root.plugin(readHistoryPlugin)
    const session = root.sessions.create({})
    const run = root.sessions.beginRun(session.id, {}, 'mock/test')
    root.sessions.append(session.id, 'user/message', { content: 'only in this session' }, run)

    const against = await root.tools.execute('read_history', { from: 1 }, { sessionId: session.id })
    assert.equal(against.isError, false)
    assert.match(root.tools.renderResult(against), /only in this session/)
    const anonymous = await root.tools.execute('read_history', { from: 1 }, {})
    assert.equal(anonymous.isError, true)
    assert.match(root.tools.renderResult(anonymous), /requires a session/)
  } finally { await root.fiber.dispose() }

  // 释放之后同一个名字可以被重新注册：这才真正说明上一个注册已经撤销（重名会抛 duplicate tool name）。
  const reopened = new Context()
  try {
    await reopened.plugin(sessions)
    await reopened.plugin(tools)
    await reopened.plugin(readHistoryPlugin)
    assert.ok(reopened.tools.get('read_history'))
  } finally { await reopened.fiber.dispose() }
})

test('read_history output is not re-truncated by the result projection', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-history-'))
  const root = new Context()
  try {
    await root.plugin(sessions)
    await root.plugin(tools)
    await root.plugin(sandbox, { workspace, autoApprove: true })
    await root.plugin(toolResults)                                   // 默认预览上限 16 KiB
    await root.plugin(readHistoryPlugin, { maxBytes: 32 * 1024 })
    const session = root.sessions.create({ workspace })
    const run = root.sessions.beginRun(session.id, {}, 'mock/test')
    root.sessions.append(session.id, 'user/message', { content: 'z'.repeat(40_000) }, run)

    // 从那条超大事件本身的 seq 开始读：一次调用就产出一页超过预览上限的输出。这正是「按 seq 分页」
    // 而不是「按 ref 分页」——被结果投影换成预览加引用的话，这一页就再也拿不回来了。
    const huge = root.sessions.visibleEvents(session.id).find(event => event.type === 'user/message')!.seq
    const result = await root.tools.execute('read_history', { from: huge, maxBytes: 32 * 1024 }, { sessionId: session.id, signal: new AbortController().signal })
    const text = root.tools.renderResult(result)
    assert.ok(Buffer.byteLength(text) > 16 * 1024, '输出确实超过了预览上限，却没被换成预览')
    assert.match(text, /z{1000}/)
    assert.doesNotMatch(text, /\[tool_result /)
  } finally {
    await root.fiber.dispose()
    assert.equal(path.dirname(workspace), path.resolve(os.tmpdir()))
    await fs.rm(workspace, { recursive: true, force: true })
  }
})
