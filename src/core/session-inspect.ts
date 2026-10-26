import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createLogRecordParser, isRecord } from './event-store.js'
import { TokenObservationCollector } from './token-calibration.js'
import type { TokenErrorSummary } from './token-calibration.js'
import type { SessionEvent } from './contracts.js'

export interface InspectWarning { code: 'truncated_tail' | 'corrupt_json' | 'unknown_event_type' | 'invalid_record' | 'invalid_utf8' | 'changed_during_read' | 'read_error' | 'missing_session_start'; line: number; byteOffset: number; message: string }
export interface InspectReport {
  version: 2
  integrity: { complete: boolean; confirmedEvents: number; confirmedBytes: number; warnings: InspectWarning[] }
  session: { id: string | null; startedAt: string | null; endedAt: null; lastRecordedAt: string | null; runs: number; finishedRuns: number; resets: number }
  latestRun: { id: string; taskId: string; startedAt: string; finishedAt: string | null; status: string; stopReason: string | null } | null
  errors: { count: number; last: { runId: string; stage: string; errorKind: string; safeMessage: string; requestId?: string; toolCallId?: string; httpStatus?: number } | null }
  requests: { main: number; summary: number; retries: number; preDispatchRejected: number; preparedUnsent: number; missingUsage: number; estimatedUsage: number }
  tools: { calls: number; confirmedErrors: number; unknownOutcomes: number; skipped: number }
  providerUsage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheReadFieldMissing: number }
  mechanisms: { compactionAttempts: number; compactionApplied: number; compactionDeclined: number; historyReads: number; previewTruncations: number }
  frozenSnapshots: { currentEpoch: { runtime: string | null; project: string | null }; legacyCurrentRecorded: number }
  // R06 阶段 A：只读观测。只用 provider usage 配对 model/start；缺失、估算或零实际值单列，不进误差统计。
  tokenError: TokenErrorSummary
  trace?: { events: { seq: number; type: string; detail?: string }[]; truncated: boolean }
}

type Request = { kind: 'main' | 'summary'; rejected: boolean; usage: boolean; estimated: boolean }
const knownTypes = new Set(['verification/start', 'verification/result', 'file/baseline', 'file/observed', 'file/change', 'file/change-result', 'session/start', 'session/config', 'session/reset', 'context/snapshot', 'context/project-version', 'user/message', 'assistant/message', 'assistant/tool_calls', 'tool/result', 'run/start', 'run/error', 'run/finish', 'model/start', 'model/retry', 'model/rejected', 'context/projection', 'context/summary-start', 'context/summary-end', 'context/pressure-suppressed', 'context/summary', 'model/fragment', 'model/end', 'model/usage', 'tool/start'])
const safeToolName = (name: string | undefined) => name && /^[\w.:-]{1,80}$/.test(name) ? name : undefined
for (const type of ['memory/view', 'memory/query', 'memory/proposal-receipt']) knownTypes.add(type)
for (const type of ['group/start', 'group/budget-reserved', 'group/model-dispatched', 'group/reservation-released', 'group/usage-unknown', 'group/budget-settled', 'group/tool-admitted']) knownTypes.add(type)
for (const type of ['delegation/start', 'delegation/child-created', 'delegation/child-finish', 'delegation/finish']) knownTypes.add(type)

function warning(error: unknown, line: number, byteOffset: number): InspectWarning {
  const message = error instanceof Error ? error.message : String(error)
  const code = error instanceof SyntaxError || message.startsWith('corrupt JSONL record') ? 'corrupt_json' : 'invalid_record'
  return { code, line, byteOffset, message: code === 'corrupt_json' ? 'Invalid JSON record' : 'Invalid event envelope, payload, or event sequence' }
}

export async function inspectSession(file: string, options: { trace?: boolean } = {}): Promise<InspectReport> {
  const before = await stat(file)
  if (!before.isFile()) throw new Error('inspect path must be a JSONL file')
  const report: InspectReport = {
    version: 2,
    integrity: { complete: true, confirmedEvents: 0, confirmedBytes: 0, warnings: [] },
    session: { id: null, startedAt: null, endedAt: null, lastRecordedAt: null, runs: 0, finishedRuns: 0, resets: 0 },
    latestRun: null,
    errors: { count: 0, last: null },
    requests: { main: 0, summary: 0, retries: 0, preDispatchRejected: 0, preparedUnsent: 0, missingUsage: 0, estimatedUsage: 0 },
    tools: { calls: 0, confirmedErrors: 0, unknownOutcomes: 0, skipped: 0 },
    providerUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheReadFieldMissing: 0 },
    mechanisms: { compactionAttempts: 0, compactionApplied: 0, compactionDeclined: 0, historyReads: 0, previewTruncations: 0 },
    frozenSnapshots: { currentEpoch: { runtime: null, project: null }, legacyCurrentRecorded: 0 },
    tokenError: new TokenObservationCollector().summary(),
    ...(options.trace ? { trace: { events: [], truncated: false } } : {}),
  }
  const requests = new Map<string, Request>()
  const projections = new Map<string, string>()
  const finishedRuns = new Set<string>()
  const awaitingSummary = new Set<string>()
  let parser: ReturnType<typeof createLogRecordParser> | undefined
  let lineNumber = 0
  let stopped = false
  let parts: string[] = []
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const warn = (code: InspectWarning['code'], line: number, byteOffset: number, message: string) => {
    report.integrity.complete = false
    report.integrity.warnings.push({ code, line, byteOffset, message })
  }
  const tokenCollector = new TokenObservationCollector()
  function accept(event: SessionEvent) {
    tokenCollector.observe(event)
    report.integrity.confirmedEvents++
    report.session.lastRecordedAt = event.at
    if (report.trace && !['model/fragment', 'user/message', 'assistant/message', 'assistant/tool_calls'].includes(event.type)) {
      let detail: string | undefined
      if (event.type === 'tool/start' || event.type === 'tool/result') detail = safeToolName(event.data.name)
      else if (event.type === 'run/finish') detail = event.data.state.status
      else if (event.type === 'run/error') detail = `${event.data.stage}: ${event.data.errorKind}`
      else if (event.type === 'model/rejected') detail = event.data.reason
      else if (event.type === 'context/snapshot') detail = `${event.data.name}: ${event.data.source}`
      else if (event.type === 'context/project-version') detail = event.data.previousDigest ? 'changed' : 'initial'
      else if (event.type === 'context/summary-end') detail = event.data.outcome.kind
      else if (event.type === 'context/pressure-suppressed') detail = event.data.reason
      report.trace.events.push({ seq: event.seq, type: event.type, ...(detail ? { detail } : {}) })
      if (report.trace.events.length > 40) { report.trace.events.shift(); report.trace.truncated = true }
    }
    switch (event.type) {
      case 'session/start':
        if (report.session.id === null) { report.session.id = event.sessionId; report.session.startedAt = event.at }
        break
      case 'session/reset':
        report.session.resets++
        report.frozenSnapshots.currentEpoch = { runtime: null, project: null }
        break
      case 'context/snapshot':
        report.frozenSnapshots.currentEpoch[event.data.name === 'runtime:environment' ? 'runtime' : 'project'] = event.data.source
        if (event.data.source === 'legacy-current') report.frozenSnapshots.legacyCurrentRecorded++
        break
      case 'run/start':
        report.session.runs++
        report.latestRun = { id: event.data.state.runId, taskId: event.data.state.taskId, startedAt: event.at, finishedAt: null, status: 'unrecorded_end', stopReason: null }
        break
      case 'run/finish':
        report.session.finishedRuns++
        finishedRuns.add(event.data.state.runId)
        if (report.latestRun?.id === event.data.state.runId) {
          report.latestRun.finishedAt = event.at
          report.latestRun.status = event.data.state.status
          report.latestRun.stopReason = event.data.state.status
        }
        break
      case 'run/error':
        report.errors.count++
        report.errors.last = { runId: event.runId!, stage: event.data.stage, errorKind: event.data.errorKind, safeMessage: event.data.safeMessage,
          ...(event.data.requestId ? { requestId: event.data.requestId } : {}), ...(event.data.toolCallId ? { toolCallId: event.data.toolCallId } : {}),
          ...(event.data.httpStatus ? { httpStatus: event.data.httpStatus } : {}) }
        break
      case 'context/projection':
        if (event.data.requestId && event.runId) projections.set(event.data.requestId, event.runId)
        break
      case 'context/summary-start':
        report.mechanisms.compactionAttempts++
        if (event.runId) awaitingSummary.add(event.runId)
        break
      case 'context/summary-end':
        if (event.data.outcome.kind === 'applied') report.mechanisms.compactionApplied++
        else report.mechanisms.compactionDeclined++
        if (event.runId) awaitingSummary.delete(event.runId)
        break
      case 'model/start': {
        const kind = event.runId && awaitingSummary.has(event.runId) ? 'summary' : 'main'
        if (event.runId) awaitingSummary.delete(event.runId)
        requests.set(event.data.requestId, { kind, rejected: false, usage: false, estimated: false })
        break
      }
      case 'model/retry':
        report.requests.retries++
        break
      case 'model/rejected':
        requests.get(event.data.requestId)!.rejected = true
        report.requests.preDispatchRejected++
        break
      case 'model/usage': {
        const request = requests.get(event.data.requestId)!
        request.usage = true
        request.estimated = event.data.usage.source === 'estimated'
        if (event.data.usage.source === 'provider') {
          report.providerUsage.inputTokens += event.data.usage.inputTokens
          report.providerUsage.outputTokens += event.data.usage.outputTokens
          if (event.data.usage.cacheReadTokens === undefined) report.providerUsage.cacheReadFieldMissing++
          else report.providerUsage.cacheReadTokens += event.data.usage.cacheReadTokens
        }
        break
      }
      case 'tool/start':
        report.tools.calls++
        if (event.data.name === 'read_history') report.mechanisms.historyReads++
        break
      case 'tool/result':
        if (event.data.status === 'skipped') report.tools.skipped++
        else if (event.data.status === 'unknown') report.tools.unknownOutcomes++
        else if (event.data.isError) report.tools.confirmedErrors++
        if (event.data.previewTruncated) report.mechanisms.previewTruncations++
        break
    }
  }
  function completeLine(line: string) {
    lineNumber++
    try {
      const raw: unknown = JSON.parse(line)
      if (isRecord(raw) && typeof raw.type === 'string' && !knownTypes.has(raw.type)) {
        warn('unknown_event_type', lineNumber, report.integrity.confirmedBytes, 'Unknown event type')
        stopped = true
        return
      }
      if (!parser) {
        if (!isRecord(raw) || typeof raw.sessionId !== 'string') throw new Error('invalid first event')
        parser = createLogRecordParser(raw.sessionId)
      }
      const event = parser(line)
      if (lineNumber === 1 && event.type !== 'session/start') throw new Error('missing session start')
      accept(event)
      report.integrity.confirmedBytes += Buffer.byteLength(line) + 1
    } catch (error) {
      const found = warning(error, lineNumber, report.integrity.confirmedBytes)
      warn(error instanceof Error && error.message === 'missing session start' ? 'missing_session_start' : found.code, lineNumber, found.byteOffset, found.message)
      stopped = true
    }
  }
  function chunk(text: string) {
    let from = 0, newline = text.indexOf('\n')
    while (newline >= 0 && !stopped) {
      parts.push(text.slice(from, newline))
      completeLine(parts.join(''))
      parts = []
      from = newline + 1
      newline = text.indexOf('\n', from)
    }
    if (!stopped && from < text.length) parts.push(text.slice(from))
  }
  try {
    for await (const bytes of createReadStream(file)) {
      chunk(decoder.decode(bytes as Buffer, { stream: true }))
      if (stopped) break
    }
    if (!stopped) chunk(decoder.decode())
  } catch (error) {
    warn(error instanceof TypeError ? 'invalid_utf8' : 'read_error', lineNumber + 1, report.integrity.confirmedBytes, error instanceof TypeError ? 'Invalid UTF-8' : 'Read failed before end of file')
    stopped = true
  }
  if (!stopped && parts.length) warn('truncated_tail', lineNumber + 1, report.integrity.confirmedBytes, 'Final JSONL record has no newline; not counted')
  if (!stopped && report.integrity.confirmedEvents === 0 && !parts.length) warn('missing_session_start', 1, 0, 'No session/start event')
  const after = await stat(file).catch(() => undefined)
  if (!after || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino)
    warn('changed_during_read', lineNumber + 1, report.integrity.confirmedBytes, 'File changed during inspection; prefix only')
  for (const [requestId, request] of requests) {
    if (request.rejected) continue
    report.requests[request.kind]++
    if (!request.usage) report.requests.missingUsage++
    if (request.estimated) report.requests.estimatedUsage++
    projections.delete(requestId)
  }
  for (const [requestId, runId] of projections) if (!requests.has(requestId) && finishedRuns.has(runId)) report.requests.preparedUnsent++
  report.tokenError = tokenCollector.summary()
  return report
}

export function formatInspect(report: InspectReport) {
  const { session, latestRun, errors, requests, tools, providerUsage, mechanisms, frozenSnapshots, tokenError, integrity } = report
  const percent = (value: number) => `${(value * 100).toFixed(2)}%`
  return [
    `Session ${session.id ?? 'unknown'} — ${integrity.complete ? 'complete JSONL' : 'PARTIAL EVIDENCE'} (${integrity.confirmedEvents} events)`,
    `Started: ${session.startedAt ?? 'unknown'}; session end: not recorded; last event: ${session.lastRecordedAt ?? 'none'}`,
    `Runs: ${session.runs} (${session.finishedRuns} finished, ${session.resets} resets); latest: ${latestRun ? `${latestRun.status} (${latestRun.stopReason ?? 'no recorded end'})` : 'none'}`,
    `Recorded errors: ${errors.count}; last: ${errors.last ? `${errors.last.stage}/${errors.last.errorKind}: ${errors.last.safeMessage}${errors.last.httpStatus ? ` (HTTP ${errors.last.httpStatus})` : ''}` : latestRun?.status === 'error' ? 'unknown (legacy or interrupted log)' : 'none'}`,
    `Requests dispatched: main ${requests.main}, summary ${requests.summary}; pre-dispatch rejected ${requests.preDispatchRejected}, prepared unsent ${requests.preparedUnsent}; missing usage ${requests.missingUsage}, estimated usage ${requests.estimatedUsage}`,
    `Tools: calls ${tools.calls}, confirmed errors ${tools.confirmedErrors}, unknown outcomes ${tools.unknownOutcomes}, skipped ${tools.skipped}`,
    `Provider usage: input ${providerUsage.inputTokens}, output ${providerUsage.outputTokens}, cache read ${providerUsage.cacheReadTokens} (${providerUsage.cacheReadFieldMissing} provider records omit cache field)`,
    `Mechanisms: compaction attempts ${mechanisms.compactionAttempts}, applied ${mechanisms.compactionApplied}, declined ${mechanisms.compactionDeclined}; read_history ${mechanisms.historyReads}; preview truncations ${mechanisms.previewTruncations}`,
    `Frozen snapshot source (current epoch): runtime ${frozenSnapshots.currentEpoch.runtime ?? 'none'}, project ${frozenSnapshots.currentEpoch.project ?? 'none'}; legacy-current records ${frozenSnapshots.legacyCurrentRecorded}`,
    `Token error (provider usage only): ${tokenError.samples} samples in ${tokenError.groups.length} groups; median ${percent(tokenError.medianRelativeError)}, underestimate ${percent(tokenError.underestimateRate)}, |error| p50 ${percent(tokenError.p50AbsRelativeError)} / p95 ${percent(tokenError.p95AbsRelativeError)}; excluded missing usage ${tokenError.excluded.missingUsage}, estimated usage ${tokenError.excluded.estimatedUsage}, zero actual ${tokenError.excluded.actualZero}, orphan usage ${tokenError.excluded.orphanUsage}, rejected ${tokenError.excluded.rejected}`,
    ...integrity.warnings.map(item => `WARNING ${item.code} at line ${item.line}, byte ${item.byteOffset}: ${item.message}`),
    ...(report.trace ? ['Trace (last 40 selected metadata events):', ...report.trace.events.map(event => `  #${event.seq} ${event.type}${event.detail ? ` ${event.detail}` : ''}`), ...(report.trace.truncated ? ['  ... earlier selected events omitted'] : [])] : []),
  ].join('\n')
}
