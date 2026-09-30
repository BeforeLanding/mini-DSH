import type { SessionEvent } from './contracts.js'
import type { SessionRuntime } from './session-runtime.js'

type Sessions = Pick<SessionRuntime, 'confirmedEvents'>

function runSummary(events: SessionEvent[], runId: string) {
  const start = events.find(event => event.type === 'run/start' && event.data.state.runId === runId)
  const finish = [...events].reverse().find(event => event.type === 'run/finish' && event.data.state.runId === runId)
  const state = finish?.type === 'run/finish' ? finish.data.state : start?.type === 'run/start' ? start.data.state : undefined
  const terminal = finish?.type === 'run/finish' ? finish.data.state.counters : undefined
  return {
    model: state?.model ?? null,
    runStatus: finish?.type === 'run/finish' ? finish.data.state.status : 'running',
    stopReason: finish?.type === 'run/finish' ? finish.data.state.status : null,
    // 计数只在 run/start（全零）与 run/finish（终值）落盘，进行中的 run 没有可读的中间值。
    // 未结束时返回 null，避免把起始零值当成已发生的用量报告。字段逐项列出以免 Counters 演进时外泄新字段。
    counters: terminal ? {
      modelRequests: terminal.modelRequests, toolCalls: terminal.toolCalls,
      inputTokens: terminal.inputTokens, outputTokens: terminal.outputTokens, totalTokens: terminal.totalTokens,
      activeDurationMs: terminal.activeDurationMs, approvalDurationMs: terminal.approvalDurationMs,
    } : null,
  }
}

export function requestTrace(sessions: Sessions, sessionId: string, offset = 0, maxRequests = 20) {
  const confirmed = sessions.confirmedEvents(sessionId)
  const latest = [...confirmed].reverse().find(event => event.type === 'run/start')
  const taskId = latest?.type === 'run/start' ? latest.data.state.taskId : null
  const events = taskId ? confirmed.filter(event => event.taskId === taskId) : []
  const starts = events.filter(event => event.type === 'model/start')
  const page = starts.slice(offset, offset + maxRequests)
  const sent = new Set(starts.map(start => start.data.requestId))
  const requests = page.map(start => {
    const next = starts.find(candidate => candidate.seq > start.seq)
    const window = events.filter(event => event.seq > start.seq && event.seq < (next?.seq ?? Number.POSITIVE_INFINITY))
    // 优先按 requestId 归属；旧日志的投影没有该字段，退回到“同一 run 内最近一个投影”，
    // 并如实标注所用方式，使两种来源的结论不会被混为一谈。
    const linked = events.find(event => event.type === 'context/projection' && event.data.requestId === start.data.requestId)
    const preceding = [...events].reverse().find(event => event.type === 'context/projection' && event.runId === start.runId && event.seq < start.seq)
    const projection = linked ?? preceding
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
      projectionLink: linked ? 'requestId' as const : preceding ? 'positional' as const : null,
      usage: usage?.type === 'model/usage' ? usage.data.usage : null,
      completion: end?.type === 'model/end' ? { complete: end.data.complete, finishReason: end.data.finishReason ?? null } : null,
      response: response?.type === 'assistant/message' ? { kind: 'message' as const } : response?.type === 'assistant/tool_calls' ? { kind: 'tool_calls' as const, toolCalls } : { kind: 'missing' as const },
    }
  })
  // 投影已发出但没有对应 model/start：请求在发出前因 context_overflow 或 token 预算被拦下。
  // 这类请求不出现在 requests 中，因此单独列出，否则停止原因会缺少“为何没有发出”的证据。
  // 限定在已结束的 run 内：投影与 model/start 的落盘确认是异步的，进行中的 run 里两者之间存在窗口，
  // 不设该限定会让同一份日志因读取时机不同而给出不同结论。
  const settled = new Set(events.flatMap(event => event.type === 'run/finish' ? [event.data.state.runId] : []))
  const unsentProjections = events.flatMap(event => event.type === 'context/projection' && event.data.requestId !== undefined && !sent.has(event.data.requestId) && event.runId !== undefined && settled.has(event.runId)
    ? [{
        requestId: event.data.requestId, runId: event.runId ?? null, seq: event.seq, at: event.at,
        estimatedInputTokens: event.data.estimatedInputTokens, reservedOutputTokens: event.data.reservedOutputTokens,
        safetyMarginTokens: event.data.safetyMarginTokens, removedTaskIds: event.data.removedTaskIds,
      }]
    : [])
  const nextOffset = Math.min(starts.length, offset + requests.length)
  return {
    sessionId,
    taskId,
    requests,
    unsentProjections,
    total: starts.length,
    offset,
    nextOffset,
    eof: nextOffset >= starts.length,
    scope: 'confirmed events for the current task; summaries omit prompts, reasoning, arguments, result bodies and logs; pages are not snapshots; projections are linked by requestId when present and otherwise by the nearest preceding projection in the same run; run counters are the terminal snapshot and are null until the run finishes; unsentProjections covers the whole task rather than the page and lists only projections belonging to a finished run, so it is stable once a run ends',
  }
}
