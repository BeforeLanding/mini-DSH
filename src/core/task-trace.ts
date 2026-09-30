import type { SessionEvent } from './contracts.js'
import type { SessionRuntime } from './session-runtime.js'

type Sessions = Pick<SessionRuntime, 'confirmedEvents'>

function runSummary(events: SessionEvent[], runId: string) {
  const start = events.find(event => event.type === 'run/start' && event.data.state.runId === runId)
  const finish = [...events].reverse().find(event => event.type === 'run/finish' && event.data.state.runId === runId)
  const state = finish?.type === 'run/finish' ? finish.data.state : start?.type === 'run/start' ? start.data.state : undefined
  return {
    model: state?.model ?? null,
    runStatus: finish?.type === 'run/finish' ? finish.data.state.status : 'running',
    stopReason: finish?.type === 'run/finish' ? finish.data.state.status : null,
  }
}

export function requestTrace(sessions: Sessions, sessionId: string, offset = 0, maxRequests = 20) {
  const confirmed = sessions.confirmedEvents(sessionId)
  const latest = [...confirmed].reverse().find(event => event.type === 'run/start')
  const taskId = latest?.type === 'run/start' ? latest.data.state.taskId : null
  const events = taskId ? confirmed.filter(event => event.taskId === taskId) : []
  const starts = events.filter(event => event.type === 'model/start')
  const page = starts.slice(offset, offset + maxRequests)
  const requests = page.map(start => {
    const next = starts.find(candidate => candidate.seq > start.seq)
    const window = events.filter(event => event.seq > start.seq && event.seq < (next?.seq ?? Number.POSITIVE_INFINITY))
    const projection = [...events].reverse().find(event => event.type === 'context/projection' && event.runId === start.runId && event.seq < start.seq)
    const end = window.find(event => event.type === 'model/end' && event.data.requestId === start.data.requestId)
    const usage = window.find(event => event.type === 'model/usage' && event.data.requestId === start.data.requestId)
    const response = window.find(event => event.type === 'assistant/message' || event.type === 'assistant/tool_calls')
    const run = runSummary(events, start.data.runId)
    const toolCalls = response?.type === 'assistant/tool_calls' ? response.data.toolCalls.map(call => {
      const started = window.some(event => event.type === 'tool/start' && event.data.toolCallId === call.id)
      const matched = window.find(event => event.type === 'tool/result' && event.data.toolCallId === call.id)
      const result = matched?.type === 'tool/result' ? matched : undefined
      const resultStatus = result ? result.data.status ?? 'completed' : null
      const outcome = !result ? 'missing' : resultStatus === 'skipped' || resultStatus === 'unknown' ? resultStatus : result.data.isError ? 'failed' : 'completed'
      return {
        toolCallId: call.id,
        name: call.name,
        started,
        resultStatus,
        outcome,
        isError: result ? result.data.isError ?? false : null,
        changeIds: window.filter(event => event.type === 'file/change' && event.data.toolCallId === call.id).map(event => event.type === 'file/change' ? event.data.changeId : ''),
        verificationIds: window.filter(event => event.type === 'verification/start' && event.data.toolCallId === call.id).map(event => event.type === 'verification/start' ? event.data.verificationId : ''),
      }
    }) : []
    return {
      requestId: start.data.requestId,
      runId: start.data.runId,
      seq: start.seq,
      at: start.at,
      ...run,
      estimatedInputTokens: start.data.estimatedInputTokens ?? null,
      projection: projection?.type === 'context/projection' ? projection.data : null,
      usage: usage?.type === 'model/usage' ? usage.data.usage : null,
      completion: end?.type === 'model/end' ? { complete: end.data.complete, finishReason: end.data.finishReason ?? null } : null,
      response: response?.type === 'assistant/message' ? { kind: 'message' as const } : response?.type === 'assistant/tool_calls' ? { kind: 'tool_calls' as const, toolCalls } : { kind: 'missing' as const },
    }
  })
  const nextOffset = Math.min(starts.length, offset + requests.length)
  return {
    sessionId,
    taskId,
    requests,
    total: starts.length,
    offset,
    nextOffset,
    eof: nextOffset >= starts.length,
    scope: 'confirmed events for the current task; summaries omit prompts, reasoning, arguments, result bodies and logs; pages are not snapshots',
  }
}
