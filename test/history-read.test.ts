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

type H = ReturnType<typeof harness>

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

const compact = (h: H, run: RunState, runtime: CompactionRuntime) => runtime.compact({
  sessionId: h.session.id, state: run, trigger: 'explicit', budgetTokens: 65_536, projectedTokens: 60_000,
  retainRatio: 0.1, maxSummaryTokens: 8192, system: 'system', tools: [], model: 'mock/test',
  signal: new AbortController().signal, check: () => {}, outputAllowance: () => 8192,
})

const visibleSeqs = (h: H) => h.sessions.visibleEvents(h.session.id).map(event => event.seq)

// 分页游标是 (nextSeq, nextOffset) 一对。**只跟 nextSeq 会原地打转**——这条助手把正确用法固定下来，
// 并且每次都断言游标按字典序严格前进，否则同样的预算会一页页地重读同一条超大事件。
function readAll(h: H, from: number, to?: number, maxBytes?: number) {
  const pages: string[] = []
  let seq = from
  let offset = 0
  for (let guard = 0; guard < 500; guard++) {
    const page = readHistory(h.sessions, h.session.id, seq, to, maxBytes, undefined, offset)
    assert.ok(page.content.length > 0, '每一页都必须有内容，否则调用方会卡住')
    pages.push(page.content)
    if (page.eof) {
      assert.equal(page.nextOffset, 0, 'eof 时偏移必须归零')
      return { pages, calls: guard + 1 }
    }
    assert.ok(page.nextSeq > seq || (page.nextSeq === seq && page.nextOffset > offset),
      `游标必须字典序前进，否则分页不收敛：(${seq},${offset}) → (${page.nextSeq},${page.nextOffset})`)
    seq = page.nextSeq
    offset = page.nextOffset
  }
  assert.fail('分页必须收敛')
}

// 把「续读提示语」剥掉之后，各页拼起来必须**逐字节**等于区间内全部事件渲染文本的拼接。
// 这正是能抓住「正文装完再把提示语裁剪进正文、剪掉上一页最后一条事件尾巴」的那条断言——
// 旧实现下它会把最后一次出现的事件尾部吃掉，而 eof 仍然报 true。
const strip = (text: string) => text.replace(/\n\[truncated; continue with read_history from=\d+ offset=\d+\]/g, '')
const rejoin = (pages: string[]) => pages.map(strip).join('')

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
  assert.equal(read.nextOffset, 0)
  assert.equal(read.nextSeq, visibleSeqs(h).at(-1)! + 1)
  assert.equal(read.totalEvents, visibleSeqs(h).length)
})

test('the read-back pages forward with the (seq, offset) cursor until eof and reassembles byte for byte', async () => {
  const { h, run, runtime } = compactedSession()
  await compact(h, run, runtime)
  const first = visibleSeqs(h)[0]!
  const last = visibleSeqs(h).at(-1)!

  // 一页装得下的那份是「真值」：分页读出来的必须是它，一个字节都不差。
  const truth = readHistory(h.sessions, h.session.id, first, last)
  assert.equal(truth.eof, true)

  for (const maxBytes of [128, 200, 1024]) {
    const { pages, calls } = readAll(h, first, last, maxBytes)
    assert.ok(calls > 1, `maxBytes=${maxBytes} 应当确实分了页`)
    assert.equal(rejoin(pages), truth.content, `maxBytes=${maxBytes} 时逐字节重装必须与整页读一致`)
  }
})

test('an event larger than one page is recovered in full across several pages', () => {
  const h = harness(async () => ({ content: 'unused' }))
  const run = h.sessions.beginRun(h.session.id, policy, 'mock/test')
  const TAIL = 'THE-VERY-END-OF-THE-EVENT'
  const huge = h.sessions.append(h.session.id, 'user/message', { content: 'q'.repeat(40_000) + TAIL }, run).seq

  // 上一页尾部装不下它：停在它之前，下一页从它**开头**读起（游标偏移归零）。
  const first = readHistory(h.sessions, h.session.id, 1, undefined, 1024)
  assert.equal(first.eof, false)
  assert.equal(first.nextSeq, huge)
  assert.equal(first.nextOffset, 0)

  const { pages, calls } = readAll(h, huge, undefined, 1024)
  assert.ok(calls > 1 && calls < 100, `超大事件要分多页、但必须收敛，实测 ${calls} 页`)
  const whole = rejoin(pages)
  assert.equal((whole.match(/q/g) ?? []).length, 40_000, '每一个字节都要取得回来')
  assert.equal(whole.split(TAIL).length - 1, 1, '尾部标记恰好出现一次')
  for (const page of pages) assert.ok(Buffer.byteLength(page) <= 1024, '正文绝不超出预算')
  // 中途的每一页都指向同一条事件，偏移严格递增——这就是「只跟 nextSeq 会打转」的原因。
  const mid = readHistory(h.sessions, h.session.id, huge, undefined, 1024)
  assert.ok(mid.nextOffset > 0 && mid.nextOffset < Buffer.byteLength(mid.content), '超大事件的第一页停在事件内部')
})

test('multi-byte characters survive paging without being split into replacement characters', () => {
  const h = harness(async () => ({ content: 'unused' }))
  const run = h.sessions.beginRun(h.session.id, policy, 'mock/test')
  h.sessions.append(h.session.id, 'user/message', { content: '汉字与 emoji 🙂 混排，逐字可读。'.repeat(20) }, run)
  h.sessions.append(h.session.id, 'assistant/message', { content: '再来一段中文，让分页一定落在多字节字符上。'.repeat(20) }, run)
  const last = visibleSeqs(h).at(-1)!

  const truth = readHistory(h.sessions, h.session.id, 1, last)
  for (const maxBytes of [128, 300, 1024]) {
    const { pages } = readAll(h, 1, last, maxBytes)
    for (const page of pages) assert.doesNotMatch(page, /�/, '绝不能把多字节字符劈成替换字符')
    assert.equal(rejoin(pages), truth.content, `maxBytes=${maxBytes} 时中文与 emoji 逐字节重装`)
  }
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
  // 偏移的四种坏值：负、非整数、NaN、字符串。
  for (const bad of [-1, 1.5, Number.NaN, '3']) assert.throws(() => readHistory(h.sessions, h.session.id, 1, 2, undefined, undefined, bad), /nonnegative safe integer/)
  // 区间为空（reset 之后 from 落在第一条可见事件之前）时给出空页：不抛，也不假装读过什么。
  const fresh = new SessionRuntime()
  const id = fresh.create({}).id
  const state = fresh.beginRun(id, {}, 'mock/test')
  fresh.append(id, 'user/message', { content: 'hi' }, state)
  fresh.finishRun(state, 'completed')
  fresh.clear(id)
  const after = fresh.beginRun(id, {}, 'mock/test')
  fresh.append(id, 'user/message', { content: 'after the reset' }, after)
  const empty = readHistory(fresh, id, 1, 1)
  assert.equal(empty.eof, true)
  assert.equal(empty.content, '[no events in this range]')
  // 预算小到装不下那句「继续读」的提示语时，明确报错而不是悄悄少给——这正是旧实现丢字节的地方。
  assert.throws(() => readHistory(h.sessions, h.session.id, 1, undefined, 64), /cannot fit the continuation notice/)
})

test('an offset must land on a character boundary inside the event it addresses', () => {
  const h = harness(async () => ({ content: 'unused' }))
  const run = h.sessions.beginRun(h.session.id, policy, 'mock/test')
  const seq = h.sessions.append(h.session.id, 'user/message', { content: '你是第几条？' }, run).seq
  const whole = readHistory(h.sessions, h.session.id, seq).content
  const bytes = Buffer.from(whole)
  // `[N] user\n` 是 ASCII 前缀，紧接着就是三字节的『你』：9 是边界，10 是续字节。
  const boundary = Buffer.byteLength(`[${seq}] user\n`)
  assert.notEqual(bytes[boundary]! & 0xc0, 0x80)
  assert.equal(bytes[boundary + 1]! & 0xc0, 0x80)

  assert.throws(() => readHistory(h.sessions, h.session.id, seq, undefined, undefined, undefined, boundary + 1), /UTF-8 character boundary inside event/)
  assert.throws(() => readHistory(h.sessions, h.session.id, seq, undefined, undefined, undefined, bytes.length + 1), /UTF-8 character boundary inside event/)
  // 落在边界上就是合法的续读：从这里读回来的正是「你」开头的那一段，前缀那 9 个字节本来就不该再给。
  const resumed = readHistory(h.sessions, h.session.id, seq, undefined, undefined, undefined, boundary)
  assert.equal(resumed.content, bytes.subarray(boundary).toString('utf8'))
  assert.equal(whole.slice(0, boundary) + resumed.content, whole)
  // `offset` 等于事件文本长度：归一化成「下一条事件、偏移 0」，不报错。
  const past = readHistory(h.sessions, h.session.id, seq, undefined, undefined, undefined, bytes.length)
  assert.equal(past.nextSeq, seq + 1)
  assert.equal(past.nextOffset, 0)
})

test('non-message events are listed by type only, and the truncation is stated in the body', () => {
  const h = harness(async () => ({ content: 'unused' }))
  const run = h.sessions.beginRun(h.session.id, policy, 'mock/test')
  h.sessions.append(h.session.id, 'user/message', { content: 'z'.repeat(4000) }, run)
  const read = readHistory(h.sessions, h.session.id, 1, undefined, 200)
  assert.match(read.content, /\[1\] session\/start/)
  assert.match(read.content, /\[truncated; continue with read_history from=\d+ offset=\d+\]/)
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

test('the Cordis tool requires a session, advertises the cursor and releases its registration on dispose', async () => {
  const root = new Context()
  try {
    await root.plugin(sessions)
    await root.plugin(tools)
    await root.plugin(readHistoryPlugin)
    const session = root.sessions.create({})
    const run = root.sessions.beginRun(session.id, {}, 'mock/test')
    root.sessions.append(session.id, 'user/message', { content: 'only in this session' }, run)

    // 工具表必须把 offset 露出来，否则模型没有续读超大事件的入口。
    const schema = root.tools.schemas().find(item => item.function.name === 'read_history')!
    const properties = schema.function.parameters.properties as Record<string, { minimum?: number }>
    assert.equal(properties.offset?.minimum, 0)

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
    // 这一页停在事件内部，续读游标必须原样透出来。
    assert.match(text, /offset=\d+/)
  } finally {
    await root.fiber.dispose()
    assert.equal(path.dirname(workspace), path.resolve(os.tmpdir()))
    await fs.rm(workspace, { recursive: true, force: true })
  }
})
