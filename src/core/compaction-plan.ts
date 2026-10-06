import type { Message, SessionEvent } from './contracts.js'
import { estimateMessage } from './message-estimator.js'
import { assertToolProtocol } from './context-runtime.js'

export interface CompactionPlan {
  start: number
  end: number
  shadowedSeqs: number[]
  shadowedTokens: number
  surfaceTokens: number
  retainedNodes: number
}

export interface CompactionPlanOptions { budgetTokens: number; retainRatio: number; minShadowedNodes?: number }

export function deriveEventMessage(event: SessionEvent): Message | undefined {
  if (event.type === 'user/message') return { role: 'user', content: event.data.content }
  if (event.type === 'assistant/message') return { role: 'assistant', content: event.data.content, ...(event.data.reasoningContent ? { reasoning_content: event.data.reasoningContent } : {}) }
  if (event.type === 'assistant/tool_calls') return { role: 'assistant', content: event.data.content ?? null, ...(event.data.reasoningContent ? { reasoning_content: event.data.reasoningContent } : {}), tool_calls: event.data.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) } })) }
  if (event.type === 'tool/result') return { role: 'tool', tool_call_id: event.data.toolCallId, content: event.data.content }
  if (event.type === 'context/summary') return { role: 'user', content: event.data.frame }
  return undefined
}

export function surfaceSeqs(events: readonly SessionEvent[]): number[] {
  let surface = events.filter(event => deriveEventMessage(event) !== undefined && event.type !== 'context/summary').map(event => event.seq)
  for (const event of events) {
    if (event.type !== 'context/summary') continue
    const positions = event.data.shadowedSeqs.map(seq => surface.indexOf(seq)).filter(index => index >= 0)
    if (positions.length !== event.data.shadowedSeqs.length) continue
    const start = Math.min(...positions)
    const end = Math.max(...positions)
    if (end - start + 1 !== positions.length) continue
    const shadowed = event.data.shadowedSeqs.map(seq => events.find(candidate => candidate.seq === seq)).filter((candidate): candidate is SessionEvent => candidate !== undefined)
    if (shadowed.some(candidate => candidate.type === 'user/message' || (candidate.type === 'tool/result' && candidate.data.status === 'unknown'))) continue
    try { assertToolProtocol(shadowed.flatMap(candidate => { const item = deriveEventMessage(candidate); return item ? [item] : [] })) } catch { continue }
    surface = [...surface.slice(0, start), event.seq, ...surface.slice(end + 1)]
  }
  return surface
}

function toolResult(event: SessionEvent | undefined) { return event?.type === 'tool/result' }

/** Deterministically chooses an early, protocol-closed message range after the original request. */
export function planCompaction(events: readonly SessionEvent[], visibleSeqs: readonly number[], options: CompactionPlanOptions): CompactionPlan | undefined {
  const min = options.minShadowedNodes ?? 2
  if (visibleSeqs.length <= min) return undefined
  const bySeq = new Map(events.map(event => [event.seq, event]))
  const costs = visibleSeqs.map(seq => { const m = deriveEventMessage(bySeq.get(seq)!); return m ? estimateMessage(m) : 0 })
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
  let shadowedSeqs = visibleSeqs.slice(first, cut)
  while (shadowedSeqs.length >= min) {
    const shadowed = shadowedSeqs.map(seq => bySeq.get(seq)).filter((event): event is SessionEvent => event !== undefined)
    const retained = visibleSeqs.slice(first + shadowedSeqs.length).map(seq => bySeq.get(seq)).filter((event): event is SessionEvent => event !== undefined)
    try {
      if (shadowed.some(event => event.type === 'user/message' || (event.type === 'tool/result' && event.data.status === 'unknown'))) throw new Error('protected')
      assertToolProtocol(shadowed.flatMap(event => { const item = deriveEventMessage(event); return item ? [item] : [] }))
      assertToolProtocol(retained.flatMap(event => { const item = deriveEventMessage(event); return item ? [item] : [] }))
      break
    } catch { shadowedSeqs = shadowedSeqs.slice(0, -1) }
  }
  if (shadowedSeqs.length < min) return undefined
  cut = first + shadowedSeqs.length
  const shadowedTokens = costs.slice(first, cut).reduce((a, b) => a + b, 0)
  return { start: shadowedSeqs[0]!, end: shadowedSeqs.at(-1)!, shadowedSeqs, shadowedTokens, surfaceTokens: total, retainedNodes: visibleSeqs.length - shadowedSeqs.length }
}

export function planIsLive(plan: CompactionPlan, visibleSeqs: readonly number[]) {
  const start = visibleSeqs.indexOf(plan.start)
  return start >= 0 && plan.shadowedSeqs.every((seq, index) => visibleSeqs[start + index] === seq)
}
