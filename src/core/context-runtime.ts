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
export interface ProjectionOptions {
  // 供主动压力摘要之后使用：摘要只压当前 task，已结束且非当前的旧任务仍可能占着数万 token；
  // 按目标线把旧任务免费裁掉，避免同一 run 反复摘要。缺省保持原语义（仅在装不下时才裁剪）。
  pruneTargetTokens?: number
}
// 裁剪决定是持久化的投影状态：日志里每条 context/prune 的任务并集，后续轮次、/continue
// 与重启恢复都按它排除任务。原始事件一条不删，read_history 仍可按 seq 回读。
export function prunedTaskIds(events: readonly SessionEvent[]): string[] {
  const ids = new Set<string>()
  for (const event of events) {
    if (event.type !== 'context/prune') continue
    for (const taskId of event.data.removedTaskIds) ids.add(taskId)
  }
  return [...ids]
}
export class ContextBudgetRuntime {
  project(events: SessionEvent[], taskId: string, request: ChatRequest, policy: Readonly<BudgetPolicy>, derive: (events: SessionEvent[]) => Message[], outputAllowance?: (inputTokens: number) => number | undefined, calibrate?: (rawInputTokens: number) => number, options: ProjectionOptions = {}) {
    const groups = groupHistory(events, taskId)
    // 持久化裁剪只排除“非当前”的任务；当前 task 恒受保护，即使日志里出现同名也保留。
    const pruned = new Set(prunedTaskIds(events))
    const isPruned = (group: HistoryGroup) => group.taskId !== taskId && pruned.has(group.taskId)
    const removedTaskIds = groups.filter(isPruned).map(group => group.taskId)
    let selected = groups.filter(group => !isPruned(group))
    const measure = () => {
      const messages = derive(selected.flatMap(g => g.events))
      const rawEstimatedInputTokens = estimateInput({ ...request, messages })
      const estimatedInputTokens = calibrate?.(rawEstimatedInputTokens) ?? rawEstimatedInputTokens
      let reservedOutputTokens = request.maxOutputTokens ?? 0
      let tokenFits = true
      if (outputAllowance) {
        try { reservedOutputTokens = outputAllowance(estimatedInputTokens) ?? 0 }
        catch (error) {
          if (!(error instanceof BudgetStop) || error.reason !== 'token_budget') throw error
          tokenFits = false
          reservedOutputTokens = 0
        }
      }
      const safetyMarginTokens = Math.max(policy.safetyMarginTokens ?? 2048, Math.ceil(estimatedInputTokens * 0.1))
      const fits = tokenFits && (policy.inputTargetTokens === undefined || estimatedInputTokens <= policy.inputTargetTokens) &&
        (policy.contextWindowTokens === undefined || estimatedInputTokens + reservedOutputTokens + safetyMarginTokens <= policy.contextWindowTokens)
      return { messages, rawEstimatedInputTokens, estimatedInputTokens, safetyMarginTokens, reservedOutputTokens, fits }
    }
    let projection = measure()
    const pruneTarget = options.pruneTargetTokens
    for (const group of groups) {
      if (isPruned(group)) continue
      if (projection.fits && (pruneTarget === undefined || projection.estimatedInputTokens <= pruneTarget)) break
      if (group.protected || !group.complete) continue
      selected = selected.filter(g => g !== group)
      removedTaskIds.push(group.taskId)
      projection = measure()
    }
    assertToolProtocol(projection.messages)
    return { ...projection, removedTaskIds }
  }
}
