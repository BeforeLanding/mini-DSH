import test from 'node:test'
import assert from 'node:assert/strict'
import { planCompaction, surfaceSeqs } from '../src/core/compaction-plan.js'
import type { SessionEvent } from '../src/core/contracts.js'

const event = (seq: number, type: SessionEvent['type'], data: unknown): SessionEvent => ({ version: 1, sessionId: 's', id: String(seq), seq, type, data, at: '' } as SessionEvent)
test('planCompaction preserves the original user request and is deterministic', () => {
  const events = [event(1, 'user/message', { content: 'request' }), event(2, 'assistant/message', { content: 'a'.repeat(100) }), event(3, 'assistant/message', { content: 'b'.repeat(100) }), event(4, 'assistant/message', { content: 'tail' })]
  const first = planCompaction(events, [1, 2, 3, 4], { budgetTokens: 1000, retainRatio: 0.1 })
  const second = planCompaction(events, [1, 2, 3, 4], { budgetTokens: 1000, retainRatio: 0.1 })
  assert.deepEqual(first, second)
  assert.ok(first)
  assert.equal(first.shadowedSeqs.includes(1), false)
})
test('planCompaction does not cut a tool result into the retained side', () => {
  const events = [event(1, 'user/message', { content: 'request' }), event(2, 'assistant/tool_calls', { toolCalls: [{ id: 'c', name: 'x', arguments: {} }] }), event(3, 'tool/result', { toolCallId: 'c', content: 'result' }), event(4, 'assistant/message', { content: 'tail' })]
  const plan = planCompaction(events, [1, 2, 3, 4], { budgetTokens: 1000, retainRatio: 0.1 })
  assert.ok(plan)
  assert.deepEqual(plan.shadowedSeqs, [2, 3])
})
test('surfaceSeqs replaces a shadowed range in place and composes later summaries', () => {
  const events = [event(1, 'user/message', { content: 'request' }), event(2, 'assistant/message', { content: 'old' }), event(3, 'assistant/message', { content: 'middle' }), event(4, 'assistant/message', { content: 'tail' }),
    event(5, 'context/summary', { startSeq: 10, trigger: 'explicit', budgetTokens: 1000, projectedTokens: 900, shadowedSeqs: [2, 3], shadowedTokens: 100, summaryTokens: 10, retainedNodes: 2, summary: 'summary one', frame: 'frame one' }),
    event(6, 'context/summary', { startSeq: 11, trigger: 'explicit', budgetTokens: 1000, projectedTokens: 900, shadowedSeqs: [5, 4], shadowedTokens: 30, summaryTokens: 8, retainedNodes: 1, summary: 'summary two', frame: 'frame two' })]
  assert.deepEqual(surfaceSeqs(events), [1, 6])
})
test('plans and projections preserve user requests and unknown tool groups', () => {
  const events = [event(1, 'user/message', { content: 'request' }), event(2, 'assistant/tool_calls', { toolCalls: [{ id: 'c', name: 'x', arguments: {} }] }), event(3, 'tool/result', { toolCallId: 'c', content: 'unknown', status: 'unknown' }), event(4, 'assistant/message', { content: 'tail' })]
  assert.equal(planCompaction(events, [1, 2, 3, 4], { budgetTokens: 1000, retainRatio: 0.1 }), undefined)
  const invalid = event(5, 'context/summary', { startSeq: 10, trigger: 'explicit', budgetTokens: 1000, projectedTokens: 900, shadowedSeqs: [1, 2, 3], shadowedTokens: 100, summaryTokens: 10, retainedNodes: 1, summary: 'bad', frame: 'bad frame' })
  assert.deepEqual(surfaceSeqs([...events, invalid]), [1, 2, 3, 4])
})
test('only the first user/message is protected; a later one inside the range may be shadowed', () => {
  // §6.1 规则 1 / §7.2：当前 task 的**第一条** user/message 永不遮蔽，区间内的后续用户消息允许被遮蔽。
  // 比这更严的口径（任何 user/message 都不遮蔽）会把多轮会话压成「只能在两轮之间压」。
  const events = [event(1, 'user/message', { content: 'request' }), event(2, 'assistant/message', { content: 'a'.repeat(200) }),
    event(3, 'user/message', { content: 'a follow-up question' }), event(4, 'assistant/message', { content: 'b'.repeat(200) }),
    event(5, 'assistant/message', { content: 'tail' })]
  const plan = planCompaction(events, [1, 2, 3, 4, 5], { budgetTokens: 1000, retainRatio: 0.1 })
  assert.ok(plan, '含后续 user/message 的区间仍然可以被规划出来')
  assert.equal(plan.shadowedSeqs.includes(3), true, '后续的 user/message 允许被遮蔽')
  assert.equal(plan.shadowedSeqs.includes(1), false, '第一条 user/message 永不被遮蔽')
})
test('the plan never leaves the current task, even when an older task is still visible', () => {
  const tasked = (seq: number, taskId: string, type: SessionEvent['type'], data: unknown): SessionEvent => ({ ...event(seq, type, data), taskId })
  const events = [
    tasked(1, 'old', 'user/message', { content: 'old request' }),
    tasked(2, 'old', 'assistant/message', { content: 'old work' }),
    tasked(3, 'now', 'user/message', { content: 'current request' }),
    tasked(4, 'now', 'assistant/message', { content: 'a'.repeat(200) }),
    tasked(5, 'now', 'assistant/message', { content: 'b'.repeat(200) }),
    tasked(6, 'now', 'assistant/message', { content: 'tail' }),
  ]
  const plan = planCompaction(events, [1, 2, 3, 4, 5, 6], { budgetTokens: 1000, retainRatio: 0.1 })
  assert.ok(plan)
  // 旧任务的原文早已被裁剪移出请求；把它规划进区间，摘要会落成 applied 而投影不生效。
  assert.deepEqual(plan.shadowedSeqs.filter(seq => events.find(item => item.seq === seq)!.taskId !== 'now'), [])
  assert.equal(plan.shadowedSeqs.includes(3), false, '当前 task 的第一条 user/message 仍受保护')
})
test('surfaceSeqs accepts a summary over a later user/message but not over the original request', () => {
  const base = [event(1, 'user/message', { content: 'request' }), event(2, 'assistant/message', { content: 'a' }),
    event(3, 'user/message', { content: 'follow-up' }), event(4, 'assistant/message', { content: 'tail' })]
  const summary = (seq: number, shadowedSeqs: number[]) => event(seq, 'context/summary', { startSeq: 10, trigger: 'explicit', budgetTokens: 1000, projectedTokens: 900, shadowedSeqs, shadowedTokens: 10, summaryTokens: 5, retainedNodes: 1, summary: 's', frame: 'f' })
  // 遮蔽 [2,3]（含后续 user/message）：接受，摘要按原位替换。
  assert.deepEqual(surfaceSeqs([...base, summary(5, [2, 3])]), [1, 5, 4])
  // 遮蔽 [1,2]（含**第一条** user/message）：不接受，原文照旧——两侧口径必须一致，
  // 否则日志说 applied、投影却不生效。
  assert.deepEqual(surfaceSeqs([...base, summary(5, [1, 2])]), [1, 2, 3, 4])
})
