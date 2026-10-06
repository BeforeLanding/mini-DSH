import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CompactionRuntime } from '../src/core/compaction-runtime.js'
import type { CompactionAttempt } from '../src/core/compaction-runtime.js'
import { planCompaction, surfaceSeqs } from '../src/core/compaction-plan.js'
import { assertToolProtocol } from '../src/core/context-runtime.js'
import { JsonlStore } from '../src/core/event-store.js'
import { SessionRuntime } from '../src/core/session-runtime.js'
import { ModelStreamError } from '../src/core/model-error.js'
import { BudgetStop } from '../src/core/budget.js'
import type { RunState } from '../src/core/budget.js'
import type { Adapter } from '../src/core/contracts.js'
import { harness } from './harness.js'

const policy = { contextWindowTokens: 1_000_000, inputTargetTokens: 65_536, maxOutputTokens: 16_384 } as const

function compaction(h: ReturnType<typeof harness>) {
  return new CompactionRuntime({ sessions: h.sessions, llm: h.llm })
}

// 照 §6.1 的典型场景造一条**单任务**长会话：一条原始 user/message（必须永不被遮蔽），后面是一段
// 协议闭合的长工具链，最后留一条不愿被压掉的尾巴。
function longSingleTaskSession(chat: Adapter['chat'] = async () => ({ content: 'unused' })) {
  const h = harness(chat)
  const run = h.sessions.beginRun(h.session.id, policy, 'mock/test')
  const request = h.sessions.append(h.session.id, 'user/message', { content: 'original request: never edit src/secret.ts' }, run)
  h.sessions.append(h.session.id, 'assistant/message', { content: 'understood, reading the call site' }, run)
  h.sessions.append(h.session.id, 'assistant/tool_calls', { toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'src/cart.mjs' } }] }, run)
  h.sessions.append(h.session.id, 'tool/result', { toolCallId: 'c1', name: 'read_file', content: 'x'.repeat(4000) }, run)
  h.sessions.append(h.session.id, 'assistant/message', { content: 'recent tail' }, run)
  return { h, run, request }
}

function attemptFor(run: RunState, sessionId: string, overrides: Partial<CompactionAttempt> = {}): CompactionAttempt {
  return {
    sessionId, state: run, trigger: 'explicit', budgetTokens: 65_536, projectedTokens: 60_000,
    retainRatio: 0.1, maxSummaryTokens: 8192, system: 'system prompt', tools: [], model: 'mock/test',
    signal: new AbortController().signal, check: () => {}, outputAllowance: () => 8192, ...overrides,
  }
}

type H = ReturnType<typeof harness>
const events = (h: H) => h.sessions.visibleEvents(h.session.id)
const summaries = (h: H) => events(h).flatMap(event => event.type === 'context/summary' ? [event] : [])
const summaryStarts = (h: H) => events(h).flatMap(event => event.type === 'context/summary-start' ? [event] : [])
const summaryEnds = (h: H) => events(h).flatMap(event => event.type === 'context/summary-end' ? [event] : [])

test('compaction replaces the shadowed range with a code-written frame right after the original request', async () => {
  const { h, run, request } = longSingleTaskSession(async () => ({ content: '## Summary\n- read src/cart.mjs' }))
  const outcome = await compaction(h).compact(attemptFor(run, h.session.id))
  assert.equal(outcome.kind, 'applied')

  const messages = h.sessions.deriveMessages(h.session.id)
  assertToolProtocol(messages)
  assert.equal(messages.length, 3)
  assert.equal(messages[0]!.role, 'user')
  assert.equal(messages[0]!.content, 'original request: never edit src/secret.ts')
  // frame 落在**该条原始用户请求的正后方**，而不是整个消息序列的最前面。
  assert.equal(messages[1]!.role, 'user')
  assert.match(messages[1]!.content!, /^<system-reminder>\n/)
  // 门牌号必须与落盘的 shadowedSeqs 逐字对应——它是替换「可寻址」的全部依据。
  const applied = summaries(h)[0]!
  const [from, to] = [applied.data.shadowedSeqs[0]!, applied.data.shadowedSeqs.at(-1)!]
  assert.match(messages[1]!.content!, new RegExp(`第 ${from}–${to} 号事件（共 ${applied.data.shadowedSeqs.length} 条）`))
  assert.match(messages[1]!.content!, /## Summary/)
  assert.equal(messages[2]!.content, 'recent tail')
  // 被遮蔽的原文一条没删，仍躺在日志里。
  assert.ok(events(h).some(event => event.type === 'tool/result' && event.data.content.length === 4000))
  assert.ok(request.seq < summaries(h)[0]!.seq)
})

test('a single-task long session is compactable and the original request is never shadowed', () => {
  const { h, request } = longSingleTaskSession()
  const visible = surfaceSeqs(events(h))
  const plan = planCompaction(events(h), visible, { budgetTokens: 65_536, retainRatio: 0.1 })
  // 本项存在的理由：既有裁剪只移除已结束的旧任务，当前 task 恒受保护，所以 context_overflow 恰恰发生在
  // 单任务长会话里。若区间改回「最早的 surface 事件」起算，保护集会顶掉全部候选、规划退化成 undefined，
  // 这条断言就翻面——它测的正是这个 bug。
  assert.ok(plan, 'a single-task session must be compactable')
  assert.equal(plan!.shadowedSeqs.includes(request.seq), false)
  assert.equal(plan!.start, visible[1])
})

test('projection of a compacted log is deterministic and survives repeated derivation', async () => {
  const { h, run } = longSingleTaskSession(async () => ({ content: 'summary body' }))
  await compaction(h).compact(attemptFor(run, h.session.id))

  assert.deepEqual(h.sessions.deriveMessages(h.session.id), h.sessions.deriveMessages(h.session.id))
  const first = surfaceSeqs(events(h))
  assert.deepEqual(surfaceSeqs(events(h)), first)
  assert.deepEqual(planCompaction(events(h), first, { budgetTokens: 65_536, retainRatio: 0.1 }),
    planCompaction(events(h), first, { budgetTokens: 65_536, retainRatio: 0.1 }))
})

test('the summary call is a real request counted into the same run', async () => {
  let calls = 0
  const { h, run } = longSingleTaskSession(async () => { calls++; return { content: 'summary body', usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14, source: 'provider', uncertain: false } } })
  await compaction(h).compact(attemptFor(run, h.session.id))

  assert.equal(calls, 1)
  assert.equal(run.counters.modelRequests, 1)
  assert.equal(run.counters.inputTokens, 10)
  assert.equal(run.counters.outputTokens, 4)
  assert.equal(run.counters.totalTokens, 14)
  assert.deepEqual(run.usage.map(usage => usage.source), ['provider'])
  // 括号的形状：start 在 model/start 之前，summary 在 end 之前。
  const order = events(h).map(event => event.type)
  assert.ok(order.indexOf('context/summary-start') < order.indexOf('model/start'))
  assert.ok(order.indexOf('context/summary') < order.indexOf('context/summary-end'))
})

test('a budget shortage stops the run instead of being recorded as a summary decline', async () => {
  let calls = 0
  const { h, run } = longSingleTaskSession(async () => { calls++; return { content: 'summary body' } })

  await assert.rejects(compaction(h).compact(attemptFor(run, h.session.id, { outputAllowance: () => { throw new BudgetStop('token_budget', run) } })), /token_budget/)
  // 钱不够不是「摘要器不行」——它既不该花掉一次调用，也不该在日志里留下一个尝试。
  assert.equal(calls, 0)
  assert.deepEqual(summaryStarts(h), [])
  assert.deepEqual(summaryEnds(h), [])
})

test('declines are recorded with a closed-set reason and never produce a summary', async () => {
  const cases: [string, Adapter['chat'], string][] = [
    ['summary-failed', async () => { throw new Error('provider exploded') }, 'summary-failed'],
    ['summary-empty', async () => ({ content: '   ' }), 'summary-empty'],
    ['summary-not-smaller', async () => ({ content: 'y'.repeat(6000) }), 'summary-not-smaller'],
  ]
  for (const [label, chat, expected] of cases) {
    const { h, run } = longSingleTaskSession(chat)
    assert.deepEqual(await compaction(h).compact(attemptFor(run, h.session.id)), { kind: 'declined', reason: expected }, label)
    assert.equal(summaries(h).length, 0, label)
    const end = summaryEnds(h)
    assert.equal(end.length, 1, label)
    assert.deepEqual(end[0]!.data.outcome, { kind: 'declined', reason: expected }, label)
    // 摘要没落地，投影就没有变化。
    assert.ok(h.sessions.deriveMessages(h.session.id).some(message => message.content === 'recent tail'), label)
  }
})

test('a truncated summary is a failure, never a smaller summary that happens to fit', async () => {
  // complete=false 的正文非空、也一定更短，但它缺的正是排在八节后面的 Pending Work / Next Step /
  // Critical Context——拿它当 applied，等于把「模型没写完」伪装成压缩成功。
  const { h, run } = longSingleTaskSession(async () => ({ content: '## Primary Request\n- half a summary', complete: false, finishReason: 'length' }))
  assert.deepEqual(await compaction(h).compact(attemptFor(run, h.session.id)), { kind: 'declined', reason: 'summary-failed' })
  assert.equal(summaries(h).length, 0)
  assert.deepEqual(summaryEnds(h).map(event => event.data.outcome), [{ kind: 'declined', reason: 'summary-failed' }])
  // 日志仍如实记下这次调用没有跑完，事后可解释。
  const ended = [...events(h)].reverse().find(event => event.type === 'model/end')
  assert.equal(ended?.type === 'model/end' && ended.data.complete, false)
})

test('a failed call keeps the partial usage and the text the provider already returned', async () => {
  const { h, run } = longSingleTaskSession(async request => {
    request.onContent?.('half a summary')
    throw new ModelStreamError('stream broke', { content: 'half a summary', complete: false,
      usage: { inputTokens: 77, outputTokens: 5, totalTokens: 82, source: 'provider', uncertain: false } })
  })
  assert.deepEqual(await compaction(h).compact(attemptFor(run, h.session.id)), { kind: 'declined', reason: 'summary-failed' })
  // 供应商已经报回来的真实用量不能被一句估算盖掉——主循环早就是这么做的，压缩这一侧此前漏了。
  assert.deepEqual(run.usage.map(usage => usage.source), ['provider'])
  assert.equal(run.counters.inputTokens, 77)
  assert.equal(run.counters.outputTokens, 5)
  // 流式片段照样落盘：崩溃窗口里它是唯一能说明「模型说到哪」的东西。
  assert.ok(events(h).some(event => event.type === 'model/fragment' && event.data.content.includes('half a summary')))
  assert.equal(summaries(h).length, 0)
})

test('cancellation during the summary call is a decline and never writes an applied summary', async () => {
  const controller = new AbortController()
  const { h, run } = longSingleTaskSession(async () => { controller.abort(); return { content: 'summary body' } })

  const outcome = await compaction(h).compact(attemptFor(run, h.session.id, {
    signal: controller.signal, check: () => { throw new BudgetStop('timeout', run) } }))
  assert.deepEqual(outcome, { kind: 'declined', reason: 'cancelled' })
  assert.equal(summaries(h).length, 0)
  assert.equal(summaryStarts(h).length, 1)
})

test('nothing to plan writes no bracket at all', async () => {
  const h = harness(async () => ({ content: 'summary body' }))
  const run = h.sessions.beginRun(h.session.id, policy, 'mock/test')
  h.sessions.append(h.session.id, 'user/message', { content: 'only a request' }, run)

  assert.deepEqual(await compaction(h).compact(attemptFor(run, h.session.id)), { kind: 'skipped', reason: 'nothing-to-plan' })
  assert.deepEqual(summaryStarts(h), [])
  assert.deepEqual(summaryEnds(h), [])
})

test('protecting an unknown tool group keeps the range closed and leaves it out of the plan', () => {
  const h = harness(async () => ({ content: 'unused' }))
  const run = h.sessions.beginRun(h.session.id, policy, 'mock/test')
  h.sessions.append(h.session.id, 'user/message', { content: 'request' }, run)
  h.sessions.append(h.session.id, 'assistant/tool_calls', { toolCalls: [{ id: 'u1', name: 'bash', arguments: {} }] }, run)
  h.sessions.append(h.session.id, 'tool/result', { toolCallId: 'u1', name: 'bash', status: 'unknown', content: 'unknown outcome' }, run)
  h.sessions.append(h.session.id, 'assistant/message', { content: 'tail' }, run)
  assert.equal(planCompaction(events(h), surfaceSeqs(events(h)), { budgetTokens: 65_536, retainRatio: 0.1 }), undefined)
})

test('restore reads the recorded summary instead of asking the model again', async () => {
  let calls = 0
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-compaction-'))
  const { h, run } = longSingleTaskSession(async () => { calls++; return { content: 'summary body' } })
  const store = await JsonlStore.open(root, h.session.id)
  try {
    h.sessions.attachStore(h.session.id, store)
    assert.equal((await compaction(h).compact(attemptFor(run, h.session.id))).kind, 'applied')
    assert.equal(calls, 1)
    const before = h.sessions.deriveMessages(h.session.id)
    await h.sessions.flush(h.session.id)
    await store.close()

    const reopened = await JsonlStore.open(root, h.session.id)
    const restored = new SessionRuntime()
    await restored.restore(reopened)
    assert.equal(calls, 1, 'restore must not call the model')
    assert.deepEqual(restored.deriveMessages(h.session.id), before)
    assert.equal(restored.latestRun(h.session.id)?.counters.modelRequests, 1)
    await reopened.close()
  } finally {
    await h.sessions.close().catch(() => {})
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()))
    await fs.rm(root, { recursive: true, force: true })
  }
})
