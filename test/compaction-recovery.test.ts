import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { JsonlStore } from '../src/core/event-store.js'
import { SessionRuntime } from '../src/core/session-runtime.js'
import type { RunState } from '../src/core/budget.js'
import type { Adapter } from '../src/core/contracts.js'
import { harness } from './harness.js'

const policy = { contextWindowTokens: 1_000_000, inputTargetTokens: 65_536, maxOutputTokens: 16_384 } as const

// 崩溃残局：括号的**开始**已经落盘、付费的请求也已经发出，但进程死在摘要回来之前。
// 这就是 summary-start 必须先写的那个窗口——没有括号，「试过但失败」在日志里不存在。
function crashMidSummary(h: ReturnType<typeof harness>, options: { summary?: boolean } = {}) {
  const run: RunState = h.sessions.beginRun(h.session.id, policy, 'mock/test')
  h.sessions.append(h.session.id, 'user/message', { content: 'original request' }, run)
  h.sessions.append(h.session.id, 'assistant/message', { content: 'a'.repeat(2000) }, run)
  h.sessions.append(h.session.id, 'assistant/message', { content: 'tail' }, run)
  const start = h.sessions.append(h.session.id, 'context/summary-start', {
    trigger: 'pressure', budgetTokens: 65_536, projectedTokens: 60_000, plannedStart: 3, plannedEnd: 4, plannedNodes: 2,
  }, run)
  h.sessions.append(h.session.id, 'model/start', { taskId: run.taskId, runId: run.runId, requestId: 'crashed-request', estimatedInputTokens: 100 }, run)
  if (options.summary) {
    h.sessions.append(h.session.id, 'context/summary', {
      startSeq: start.seq, trigger: 'pressure', budgetTokens: 65_536, projectedTokens: 60_000, shadowedSeqs: [3, 4],
      shadowedTokens: 100, summaryTokens: 10, retainedNodes: 1, summary: 'early range', frame: '<system-reminder>…</system-reminder>',
    }, run)
  }
  return { run, start }
}

const endsOf = (sessions: SessionRuntime, id: string) =>
  sessions.visibleEvents(id).flatMap(event => event.type === 'context/summary-end' ? [event] : [])

async function withStore<T>(body: (open: (sessionId: string) => Promise<JsonlStore>) => Promise<T>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-compaction-recovery-'))
  try { return await body(sessionId => JsonlStore.open(root, sessionId)) }
  finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()))
    await fs.rm(root, { recursive: true, force: true })
  }
}

test('an unclosed summary attempt is closed as unclosed on recovery and never re-asks the model', async () => {
  let calls = 0
  const chat: Adapter['chat'] = async () => { calls += 1; return { content: 'unused' } }
  await withStore(async open => {
    const h = harness(chat)
    const store = await open(h.session.id)
    try {
      h.sessions.attachStore(h.session.id, store)
      const { start } = crashMidSummary(h)
      await h.sessions.flush(h.session.id)
      await store.close()

      const reopened = await open(h.session.id)
      const restored = new SessionRuntime()
      await restored.restore(reopened)
      assert.equal(calls, 0, '恢复不得重新调用模型')

      const ends = endsOf(restored, h.session.id)
      assert.equal(ends.length, 1)
      assert.equal(ends[0]!.data.startSeq, start.seq)
      assert.deepEqual(ends[0]!.data.outcome, { kind: 'declined', reason: 'unclosed' })
      // 作用域沿用原事件：补出来的这一条属于同一 task／run，折叠时才知道它算谁的。
      assert.equal(ends[0]!.taskId, start.taskId)
      assert.equal(ends[0]!.runId, start.runId)
      // 崩溃窗口里还停在 running 的 run 被封成 error，不留在半途。
      assert.ok(restored.latestRun(h.session.id)!.status !== 'running')

      // 再恢复一次：括号已经闭合，不该再补第二条，也不该抹掉第一条。
      await reopened.close()
      const again = await open(h.session.id)
      const second = new SessionRuntime()
      await second.restore(again)
      assert.equal(endsOf(second, h.session.id).length, 1)
      assert.equal(calls, 0)
      await again.close()
    } finally { await h.sessions.close().catch(() => {}) }
  })
})

test('a recorded summary is not relabelled as unclosed just because its bracket never closed', async () => {
  const h = harness(async () => ({ content: 'unused' }))
  await withStore(async open => {
    const store = await open(h.session.id)
    try {
      h.sessions.attachStore(h.session.id, store)
      const { run } = crashMidSummary(h, { summary: true })
      const projected = h.sessions.deriveMessages(h.session.id)
      await h.sessions.flush(h.session.id)
      await store.close()

      const reopened = await open(h.session.id)
      const restored = new SessionRuntime()
      await restored.restore(reopened)
      assert.deepEqual(endsOf(restored, h.session.id), [], '摘要已经落盘并生效，标成 declined 会让日志自相矛盾')
      assert.deepEqual(restored.deriveMessages(h.session.id), projected)
      assert.equal(restored.visibleEvents(h.session.id).some(event => event.type === 'context/summary' && event.runId === run.runId), true)
      await reopened.close()
    } finally { await h.sessions.close().catch(() => {}) }
  })
})

test('a properly closed summary attempt is left exactly as it was recorded', async () => {
  const h = harness(async () => ({ content: 'unused' }))
  await withStore(async open => {
    const store = await open(h.session.id)
    try {
      h.sessions.attachStore(h.session.id, store)
      const run: RunState = h.sessions.beginRun(h.session.id, policy, 'mock/test')
      h.sessions.append(h.session.id, 'user/message', { content: 'request' }, run)
      h.sessions.append(h.session.id, 'assistant/message', { content: 'work' }, run)
      const start = h.sessions.append(h.session.id, 'context/summary-start', {
        trigger: 'explicit', budgetTokens: 1000, projectedTokens: 900, plannedStart: 3, plannedEnd: 3, plannedNodes: 1,
      }, run)
      h.sessions.append(h.session.id, 'context/summary-end', { startSeq: start.seq, outcome: { kind: 'declined', reason: 'summary-empty' } }, run)
      // 正常收尾：run 已经封盘、请求也已经结算，于是恢复**没有**任何可补的东西。
      h.sessions.finishRun(run, 'max_steps')
      const before = h.sessions.visibleEvents(h.session.id).length
      await h.sessions.flush(h.session.id)
      await store.close()

      const reopened = await open(h.session.id)
      const restored = new SessionRuntime()
      await restored.restore(reopened)
      assert.equal(restored.visibleEvents(h.session.id).length, before, '已经闭合的尝试不该被追加任何东西')
      assert.deepEqual(endsOf(restored, h.session.id).map(event => event.data.outcome), [{ kind: 'declined', reason: 'summary-empty' }])
      await reopened.close()
    } finally { await h.sessions.close().catch(() => {}) }
  })
})
