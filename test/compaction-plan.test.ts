import test from 'node:test'
import assert from 'node:assert/strict'
import { planCompaction } from '../src/core/compaction-plan.js'
import type { SessionEvent } from '../src/core/contracts.js'

const event = (seq: number, type: SessionEvent['type'], data: any): SessionEvent => ({ version: 1, sessionId: 's', id: String(seq), seq, type, data, at: '' } as SessionEvent)
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
