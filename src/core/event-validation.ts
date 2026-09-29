import { resolveBudget } from './budget.js'
import { fingerprint } from './file-edit.js'
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const string = (v: unknown) => typeof v === 'string'
const integer = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const optionalString = (v: unknown) => v === undefined || string(v)
const stops = new Set(['running', 'completed', 'max_steps', 'max_tool_calls', 'timeout', 'token_budget', 'context_overflow', 'cancelled', 'error', 'approval_timeout', 'request_timeout', 'output_limit'])
function validSnapshot(value: unknown) {
  return record(value) && (value.text === null || (typeof value.text === 'string' && !value.text.includes('\0') && Buffer.from(value.text).toString('utf8') === value.text)) && value.hash === fingerprint(value.text as string | null) && (value.mode === undefined || integer(value.mode)) && optionalString(value.location)
}
const filePath = (value: unknown) => typeof value === 'string' && !!value && !/[\r\n\0]/.test(value) && !value.includes('\\') && !value.startsWith('/') && !/^[A-Za-z]:/.test(value) && !value.split('/').some(part => part === '..' || part === '.' || !part)
function validState(v: unknown): boolean {
  if (!record(v) || !string(v.sessionId) || !string(v.taskId) || !string(v.runId) || !string(v.model) || !record(v.policy) || !record(v.counters) || !stops.has(String(v.status)) || !Array.isArray(v.usage) || !v.usage.every(validUsage) || !Array.isArray(v.removedTaskIds) || !v.removedTaskIds.every(string)) return false
  const counters = v.counters
  if (v.terminalCommit !== undefined && (!record(v.terminalCommit) || !['confirmed', 'uncertain'].includes(String(v.terminalCommit.status)) || !stops.has(String(v.terminalCommit.terminalStatus)) || v.terminalCommit.terminalStatus === 'running' || typeof v.terminalCommit.activeDurationMs !== 'number' || !Number.isFinite(v.terminalCommit.activeDurationMs) || v.terminalCommit.activeDurationMs < 0)) return false
  if (counters.approvalDurationMs !== undefined && (typeof counters.approvalDurationMs !== 'number' || !Number.isFinite(counters.approvalDurationMs) || counters.approvalDurationMs < 0)) return false
  if (!['modelRequests', 'toolCalls', 'inputTokens', 'outputTokens', 'totalTokens'].every(k => integer(counters[k])) || typeof counters.activeDurationMs !== 'number' || !Number.isFinite(counters.activeDurationMs) || counters.activeDurationMs < 0) return false
  try { resolveBudget(v.policy) } catch { return false }
  return true
}
export function validUsage(v: unknown): boolean {
  return record(v) && integer(v.inputTokens) && integer(v.outputTokens) && integer(v.totalTokens) && v.totalTokens === Number(v.inputTokens) + Number(v.outputTokens) && ['provider', 'estimated'].includes(String(v.source)) && typeof v.uncertain === 'boolean' && (v.reasoningTokens === undefined || integer(v.reasoningTokens))
}
export function validatePayload(type: string, data: Record<string, unknown>) {
  let valid = false
  switch (type) {
    case 'file/baseline': valid = filePath(data.path) && validSnapshot(data.snapshot); break
    case 'file/observed': valid = filePath(data.path) && typeof data.hash === 'string' && /^(?:missing|[a-f0-9]{64})$/.test(data.hash); break
    case 'file/change': valid = string(data.changeId) && filePath(data.path) && ['edit_file', 'write_file'].includes(String(data.tool)) && optionalString(data.toolCallId) && (data.before === undefined || validSnapshot(data.before)) && (data.after === undefined || validSnapshot(data.after)); break
    case 'file/change-result': valid = string(data.changeId) && ['applied', 'unchanged', 'failed'].includes(String(data.status)) && optionalString(data.error); break
    case 'session/start': valid = record(data.meta) && (data.reset === undefined || typeof data.reset === 'boolean'); break
    case 'session/config':
      if (!string(data.model) || !record(data.budget)) break
      try { resolveBudget({ contextWindowTokens: 1 }, data.budget); valid = true } catch { valid = false }
      break
    case 'session/reset': valid = integer(data.epoch); break
    case 'user/message': valid = string(data.content); break
    case 'assistant/message': valid = string(data.content) && optionalString(data.reasoningContent); break
    case 'assistant/tool_calls': valid = (data.content == null || string(data.content)) && optionalString(data.reasoningContent) && Array.isArray(data.toolCalls) && data.toolCalls.every(c => record(c) && string(c.id) && string(c.name) && (c.arguments === undefined || record(c.arguments))); break
    case 'tool/result': valid = string(data.toolCallId) && string(data.content) && optionalString(data.name) && (data.isError === undefined || typeof data.isError === 'boolean') && (data.status === undefined || ['completed', 'skipped', 'unknown'].includes(String(data.status))); break
    case 'run/start': valid = validState(data.state) && record(data.state) && data.state.status === 'running'; break
    case 'run/finish': valid = validState(data.state) && record(data.state) && data.state.status !== 'running'; break
    case 'model/start': valid = string(data.taskId) && string(data.runId) && string(data.requestId) && (data.estimatedInputTokens === undefined || integer(data.estimatedInputTokens)); break
    case 'context/projection': valid = integer(data.estimatedInputTokens) && integer(data.reservedOutputTokens) && integer(data.safetyMarginTokens) && Array.isArray(data.removedTaskIds) && data.removedTaskIds.every(string); break
    case 'model/fragment': valid = string(data.requestId) && string(data.content) && string(data.reasoningContent); break
    case 'model/end': valid = string(data.requestId) && typeof data.complete === 'boolean' && optionalString(data.finishReason); break
    case 'model/usage': valid = string(data.taskId) && string(data.runId) && string(data.requestId) && validUsage(data.usage); break
    case 'tool/start': valid = string(data.taskId) && string(data.runId) && string(data.toolCallId) && string(data.name); break
  }
  if (!valid) throw new Error(`invalid event payload: ${type}`)
}
