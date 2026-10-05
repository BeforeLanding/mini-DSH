import type { Message, SessionEvent } from './contracts.js'
import { estimateMessage } from './message-estimator.js'

export interface CompactionPlan {
  start: number
  end: number
  shadowedSeqs: number[]
  shadowedTokens: number
  surfaceTokens: number
  retainedNodes: number
}

export interface CompactionPlanOptions { budgetTokens: number; retainRatio: number; minShadowedNodes?: number }

function message(event: SessionEvent): Message | undefined {
  if (event.type === 'user/message') return { role: 'user', content: event.data.content }
  if (event.type === 'assistant/message') return { role: 'assistant', content: event.data.content, ...(event.data.reasoningContent ? { reasoning_content: event.data.reasoningContent } : {}) }
  if (event.type === 'assistant/tool_calls') return { role: 'assistant', content: event.data.content ?? null, ...(event.data.reasoningContent ? { reasoning_content: event.data.reasoningContent } : {}), tool_calls: event.data.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) } })) }
  if (event.type === 'tool/result') return { role: 'tool', tool_call_id: event.data.toolCallId, content: event.data.content }
  return undefined
}

function toolResult(event: SessionEvent | undefined) { return event?.type === 'tool/result' }

/** Deterministically chooses an early, protocol-closed message range after the original request. */
export function planCompaction(events: readonly SessionEvent[], visibleSeqs: readonly number[], options: CompactionPlanOptions): CompactionPlan | undefined {
  const min = options.minShadowedNodes ?? 2
  if (visibleSeqs.length <= min) return undefined
  const bySeq = new Map(events.map(event => [event.seq, event]))
  const costs = visibleSeqs.map(seq => { const m = message(bySeq.get(seq)!); return m ? estimateMessage(m) : 0 })
  const total = costs.reduce((a, b) => a + b, 0)
  let anchor = visibleSeqs.findIndex(seq => bySeq.get(seq)?.type === 'user/message')
  if (anchor < 0) anchor = -1
  const first = anchor + 1
  if (visibleSeqs.length - first <= min) return undefined
  const retainBudget = Math.max(0, Math.min(options.budgetTokens, total) * options.retainRatio)
  let cut = visibleSeqs.length
  let retained = 0
  while (cut > first) {
    const next = retained + costs[cut - 1]!
    if (next > retainBudget && cut < visibleSeqs.length) break
    retained = next
    cut -= 1
  }
  while (cut < visibleSeqs.length && toolResult(bySeq.get(visibleSeqs[cut]))) cut += 1
  if (cut - first < min || cut >= visibleSeqs.length) return undefined
  const shadowedSeqs = visibleSeqs.slice(first, cut)
  if (shadowedSeqs.some(seq => bySeq.get(seq)?.type === 'user/message')) return undefined
  const shadowedTokens = costs.slice(first, cut).reduce((a, b) => a + b, 0)
  return { start: shadowedSeqs[0]!, end: shadowedSeqs.at(-1)!, shadowedSeqs, shadowedTokens, surfaceTokens: total, retainedNodes: visibleSeqs.length - shadowedSeqs.length }
}

export function planIsLive(plan: CompactionPlan, visibleSeqs: readonly number[]) {
  const start = visibleSeqs.indexOf(plan.start)
  return start >= 0 && plan.shadowedSeqs.every((seq, index) => visibleSeqs[start + index] === seq)
}
