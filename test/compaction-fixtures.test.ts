import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CompactionRuntime } from '../src/core/compaction-runtime.js'
import { readHistory } from '../src/core/history-read.js'
import { JsonlStore } from '../src/core/event-store.js'
import { SessionRuntime } from '../src/core/session-runtime.js'
import type { BudgetPolicy, RunState } from '../src/core/budget.js'
import type { Adapter, ChatRequest, ChatResponse } from '../src/core/contracts.js'
import { harness } from './harness.js'

// NX-16 点名的三类失效：约束丢失、事实幻觉、跨恢复失效。三条都在**机制**层面判，不在文笔层面判。
//
// 这一层能保证什么、不能保证什么，说清楚再动手：
//   - 能保证：Harness 一个字都不往摘要里添（`context/summary.summary` 与模型返回的正文逐字相等）；
//     frame 是代码从计划生成的，门牌号里的 seq 范围与条数与落盘的 shadowedSeqs 对得上；
//     被遮蔽的原文一条没删，按事件号可以逐字读回来。
//   - 不能保证：模型不编造。摘要里出现没发生过的事，是模型的问题，Harness 只能让它**可核对**——
//     事件号加回读入口把「核对」变成一条命令，但不保证模型真的去核对，也不保证它读了就改对。
// 把这一层说成「压缩不会丢约束」是夸大；说成「压缩可以让约束丢失这件事变成可查的」才是准确的。

const base = (overrides: BudgetPolicy = {}): BudgetPolicy => ({
  contextWindowTokens: 1_000_000, maxOutputTokens: 1000, minimumOutputTokens: 1,
  inputTargetTokens: 3000, compactionBudgetTokens: 3000, compactionRatio: 0.8, retainRatio: 0.1,
  ...overrides,
})

const CONSTRAINT = 'never touch src/secret.ts'
const SUMMARY_MARK = '上面的对话正在被摘要'
const isSummaryCall = (request: ChatRequest) =>
  typeof request.messages?.at(-1)?.content === 'string' && request.messages!.at(-1)!.content!.includes(SUMMARY_MARK)

type H = ReturnType<typeof harness>
const events = (h: H) => h.sessions.visibleEvents(h.session.id)
const summaries = (h: H) => events(h).flatMap(event => event.type === 'context/summary' ? [event] : [])

// 一条单任务长会话：原始请求（恒受保护）之后是一段会被压掉的历史。约束在两处出现——
// 一次在原始请求里（结构上永远保得住），一次在模型复述它的那条消息里（会随区间一起被换掉）。
function longSession(summaryText: string) {
  const h = harness((async (request: ChatRequest): Promise<ChatResponse> =>
    isSummaryCall(request) ? { content: summaryText } : { content: 'unused' }) as Adapter['chat'])
  const run: RunState = h.sessions.beginRun(h.session.id, base(), 'mock/test')
  const request = h.sessions.append(h.session.id, 'user/message', { content: `repair the cart. ${CONSTRAINT}` }, run)
  const restated = h.sessions.append(h.session.id, 'assistant/message', { content: `understood: I will ${CONSTRAINT}` }, run)
  h.sessions.append(h.session.id, 'assistant/tool_calls', { toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'src/cart.mjs' } }] }, run)
  h.sessions.append(h.session.id, 'tool/result', { toolCallId: 'c1', name: 'read_file', content: 'l'.repeat(12_000) }, run)
  h.sessions.append(h.session.id, 'assistant/message', { content: 'tail' }, run)
  return { h, run, request, restated }
}

const compact = (h: H, run: RunState, extra: Partial<Parameters<CompactionRuntime['compact']>[0]> = {}) =>
  new CompactionRuntime({ sessions: h.sessions, llm: h.llm }).compact({
    sessionId: h.session.id, state: run, trigger: 'explicit', budgetTokens: 3000, projectedTokens: 2900,
    retainRatio: 0.1, maxSummaryTokens: 8192, system: 'system', tools: [], model: 'mock/test',
    signal: new AbortController().signal, check: () => {}, outputAllowance: () => 8192, ...extra,
  })

test('constraint loss: what the user actually asked for stays, and what got replaced stays checkable', async () => {
  const { h, run, request, restated } = longSession('## Primary Request\n- repair the cart\n\n## Files and Code\n- src/cart.mjs')
  assert.equal((await compact(h, run)).kind, 'applied')

  const projected = h.sessions.deriveMessages(h.session.id).map(message => message.content).join('\n')
  // 原始请求落在保护集里（§7.2）：那条约束**结构上**就丢不了，压缩前后逐字相同。
  assert.ok(projected.includes(`repair the cart. ${CONSTRAINT}`))
  // 模型复述约束的那条消息随区间一起被换掉了：这才是「压缩可能让人记不住」的那一半。
  assert.ok(!projected.includes(`understood: I will ${CONSTRAINT}`))

  // 但它是**可查的**：frame 给出的事件范围覆盖了那条消息，read_history 逐字读得回来。
  const applied = summaries(h)[0]!
  assert.ok(applied.data.shadowedSeqs.includes(restated.seq))
  const read = readHistory(h.sessions, h.session.id, applied.data.shadowedSeqs[0]!, applied.data.shadowedSeqs.at(-1))
  assert.ok(read.content.includes(`understood: I will ${CONSTRAINT}`))
  assert.ok(read.content.includes('l'.repeat(1000)), '被换掉的工具结果也逐字读得回来')
  // 原始请求本身也在同一份日志里，读得到，不因为它在投影里就变成另一段历史。
  assert.ok(readHistory(h.sessions, h.session.id, request.seq, request.seq).content.includes(CONSTRAINT))
})

test('fabricated facts: the summary is reproduced verbatim so nothing invented is attributable to the harness', async () => {
  const fabricated = '## Errors and Fixes\n- the tests were already passing before any edit; no fix was needed'
  const { h, run } = longSession(fabricated)
  assert.equal((await compact(h, run)).kind, 'applied')

  const applied = summaries(h)[0]!
  // Harness 一个字都不添、一个字节都不删：摘要正文与模型返回的逐字相等。
  assert.equal(applied.data.summary, fabricated)
  // frame 是**代码写的**：门牌号里的范围与条数必须与落盘的 shadowedSeqs 对得上，否则「核对」无从下手。
  assert.equal(applied.data.shadowedSeqs.length, new Set(applied.data.shadowedSeqs).size)
  assert.ok(applied.data.frame.startsWith('<system-reminder>'))
  assert.ok(applied.data.frame.endsWith(fabricated))
  const from = Math.min(...applied.data.shadowedSeqs), to = Math.max(...applied.data.shadowedSeqs)
  assert.ok(applied.data.frame.includes(`第 ${from}–${to} 号事件（共 ${applied.data.shadowedSeqs.length} 条）`))
  // 声称的每一条事件都真的在日志里——编造的事实因此可以逐条对照，而不是只能相信摘要。
  const all = new Set(events(h).map(event => event.seq))
  assert.deepEqual(applied.data.shadowedSeqs.filter(seq => !all.has(seq)), [])
  // 落盘的那条摘要与投影里那条是同一份文本（frame 就是它），没有第二个版本。
  const projection = h.sessions.deriveMessages(h.session.id)
  assert.equal(projection.some(message => message.content === applied.data.frame), true)
})

test('across a restart: the summary survives, the projection is identical and the model is not asked again', async () => {
  let summaryCalls = 0
  const h = harness((async (request: ChatRequest): Promise<ChatResponse> => {
    if (!isSummaryCall(request)) return { content: 'unused' }
    summaryCalls += 1
    return { content: '## Current Work\n- repairing src/cart.mjs' }
  }) as Adapter['chat'])
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-compaction-fixtures-'))
  const { run } = longSessionInto(h)
  const store = await JsonlStore.open(root, h.session.id)
  try {
    h.sessions.attachStore(h.session.id, store)
    assert.equal((await compact(h, run)).kind, 'applied')
    assert.equal(summaryCalls, 1)
    const before = h.sessions.deriveMessages(h.session.id)
    await h.sessions.flush(h.session.id)
    await store.close()

    const reopened = await JsonlStore.open(root, h.session.id)
    const restored = new SessionRuntime()
    await restored.restore(reopened)
    // 重启之后：摘要还在、投影逐条相等、而且**没有再问一次模型**。
    assert.equal(summaryCalls, 1)
    assert.deepEqual(restored.deriveMessages(h.session.id), before)
    const applied = restored.visibleEvents(h.session.id).flatMap(event => event.type === 'context/summary' ? [event] : [])
    assert.equal(applied.length, 1)
    assert.equal(applied[0]!.data.summary, '## Current Work\n- repairing src/cart.mjs')
    // 被遮蔽的原文跨重启也读得回来——事件日志是唯一事实来源，这一点不随进程生死改变。
    assert.ok(readHistory(restored, h.session.id, applied[0]!.data.shadowedSeqs[0]!).content.includes('l'.repeat(1000)))
    await reopened.close()
  } finally {
    await h.sessions.close().catch(() => {})
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()))
    await fs.rm(root, { recursive: true, force: true })
  }
})

// 带 store 的那条要用同名形状，只在结尾多一步落盘；形状与 longSession 逐字一致，摘要文本另给。
function longSessionInto(h: H) {
  const run: RunState = h.sessions.beginRun(h.session.id, base(), 'mock/test')
  h.sessions.append(h.session.id, 'user/message', { content: `repair the cart. ${CONSTRAINT}` }, run)
  h.sessions.append(h.session.id, 'assistant/message', { content: `understood: I will ${CONSTRAINT}` }, run)
  h.sessions.append(h.session.id, 'assistant/tool_calls', { toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'src/cart.mjs' } }] }, run)
  h.sessions.append(h.session.id, 'tool/result', { toolCallId: 'c1', name: 'read_file', content: 'l'.repeat(12_000) }, run)
  h.sessions.append(h.session.id, 'assistant/message', { content: 'tail' }, run)
  return { run }
}
