import type { ChatRequest, Message, SessionEvent } from './contracts.js'
import type { BudgetPolicy } from './budget.js'
import { BudgetStop } from './budget.js'
import { estimateInput } from './token-estimator.js'
export interface HistoryGroup { taskId: string; events: SessionEvent[]; complete: boolean; protected: boolean }
export function assertToolProtocol(messages: Message[]) {
  const pending = new Set<string>()
  for (const message of messages) {
    if (message.role === 'tool') {
      if (!message.tool_call_id || !pending.delete(message.tool_call_id)) throw new Error('orphan tool result')
      continue
    }
    if (pending.size) throw new Error('missing tool results before next message')
    for (const call of message.tool_calls ?? []) {
      if (!call.id || pending.has(call.id)) throw new Error('duplicate/empty tool call id')
      pending.add(call.id)
    }
  }
  if (pending.size) throw new Error('missing tool result')
}
export function groupHistory(events: SessionEvent[], currentTaskId: string): HistoryGroup[] {
  const groups = new Map<string, HistoryGroup>()
  let legacy = 'legacy-start'
  for (const event of events) {
    if (event.type === 'session/start' || event.type === 'session/reset' || event.type === 'session/config') continue
    if (!event.taskId && event.type === 'user/message') legacy = `legacy-${event.seq}`
    const taskId = event.taskId ?? legacy
    let group = groups.get(taskId)
    if (!group) { group = { taskId, events: [], complete: false, protected: taskId === currentTaskId }; groups.set(taskId, group) }
    group.events.push(event)
    if (event.type === 'run/start') group.complete = false
    if (event.type === 'run/finish' || (!event.taskId && event.type === 'assistant/message')) group.complete = true
  }
  for (const group of groups.values()) {
    const calls = new Set<string>()
    for (const event of group.events) {
      if (event.type === 'assistant/tool_calls') for (const call of event.data.toolCalls) calls.add(call.id)
      if (event.type === 'tool/result') calls.delete(event.data.toolCallId)
    }
    if (calls.size || !group.complete) group.protected = true
  }
  return [...groups.values()]
}
export class ContextBudgetRuntime {
  project(events: SessionEvent[], taskId: string, request: ChatRequest, policy: Readonly<BudgetPolicy>, derive: (events: SessionEvent[]) => Message[]) {
    const groups = groupHistory(events, taskId)
    const removedTaskIds: string[] = []
    let selected = [...groups]
    const reservedOutputTokens = request.maxOutputTokens ?? 0
    const measure = () => {
      const messages = derive(selected.flatMap(g => g.events))
      const estimatedInputTokens = estimateInput({ ...request, messages })
      const safetyMarginTokens = Math.max(policy.safetyMarginTokens ?? 2048, Math.ceil(estimatedInputTokens * 0.1))
      const fits = (policy.inputTargetTokens === undefined || estimatedInputTokens <= policy.inputTargetTokens) &&
        (policy.contextWindowTokens === undefined || estimatedInputTokens + reservedOutputTokens + safetyMarginTokens <= policy.contextWindowTokens)
      return { messages, estimatedInputTokens, safetyMarginTokens, fits }
    }
    let projection = measure()
    for (const group of groups) {
      if (projection.fits) break
      if (group.protected || !group.complete) continue
      selected = selected.filter(g => g !== group)
      removedTaskIds.push(group.taskId)
      projection = measure()
    }
    assertToolProtocol(projection.messages)
    return { ...projection, removedTaskIds, reservedOutputTokens }
  }
}
