import type { SessionEvent, ToolCall } from './contracts.js'
export function pendingTools(events: SessionEvent[]) {
  const pending = new Map<string, { call: ToolCall; scope: SessionEvent; started: boolean }>()
  for (const event of events) {
    if (event.type === 'assistant/tool_calls') {
      for (const call of event.data.toolCalls) {
        const key = `${event.runId ?? 'legacy'}/${call.id}`
        if (pending.has(key)) throw new Error('duplicate pending tool call id')
        pending.set(key, { call, scope: event, started: false })
      }
    }
    if (event.type === 'tool/start') {
      const item = pending.get(`${event.runId ?? 'legacy'}/${event.data.toolCallId}`)
      if (item) item.started = true
    }
    if (event.type === 'tool/result') pending.delete(`${event.runId ?? 'legacy'}/${event.data.toolCallId}`)
  }
  return [...pending.values()]
}
