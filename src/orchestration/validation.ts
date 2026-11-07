import { recordObject, safeId, sha256 } from '../core/content-hash.js'
import { validatePayload } from '../core/event-validation.js'
import type { OrchEventType, OrchestrationEventUnion, PlanInput } from './contracts.js'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const SHA = /^[a-f0-9]{7,64}$/
const REF = /^sha256:[a-f0-9]{64}$/
const TERMINAL = new Set(['completed', 'partial', 'failed', 'cancelled', 'budget_exhausted'])
const OUTCOMES = new Set(['succeeded', 'no_changes', 'scope_violation', 'budget_stopped', 'run_failed', 'needs_input', 'interrupted', 'failed', 'cancelled', 'skipped'])
const HUMAN_KINDS = new Set(['approval', 'conflict', 'unknown_side_effects', 'budget_extension', 'question'])
const record = (value: unknown, name: string): Record<string, unknown> => {
  if (!recordObject(value)) throw new Error(`${name} must be an object`)
  return value
}
const text = (value: unknown, name: string, maxBytes: number) => {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > maxBytes) throw new Error(`${name} must be a nonempty string up to ${maxBytes} bytes`)
}
const optionalText = (value: unknown, name: string, maxBytes: number) => {
  if (value !== undefined) text(value, name, maxBytes)
}
const integer = (value: unknown, name: string, min = 0) => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) throw new Error(`${name} must be an integer >= ${min}`)
}
const sha = (value: unknown, name: string) => {
  if (typeof value !== 'string' || !SHA.test(value)) throw new Error(`${name} must be a git object id`)
}
const ref = (value: unknown, name: string) => {
  if (typeof value !== 'string' || !REF.test(value)) throw new Error(`${name} must be a sha256 content reference`)
}
function oneOf<T extends string>(value: unknown, allowed: ReadonlySet<T>, name: string): asserts value is T {
  if (typeof value !== 'string' || !allowed.has(value as T)) throw new Error(`${name} is invalid`)
}
export function relativePath(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > 1024 || /[\\\0\r\n]/.test(value) || value.startsWith('/') || /^[A-Za-z]:/.test(value)) throw new Error(`${name} must be a repository-relative path`)
  const parts = (value.endsWith('/') ? value.slice(0, -1) : value).split('/')
  if (!parts.length || parts.some(part => !part || part === '.' || part === '..')) throw new Error(`${name} must be a normalized repository-relative path`)
}
const pathList = (value: unknown, name: string, min: number, max: number) => {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new Error(`${name} must contain ${min}..${max} paths`)
  for (const item of value) relativePath(item, name)
  if (new Set(value).size !== value.length) throw new Error(`${name} must not contain duplicates`)
}
const stringList = (value: unknown, name: string, min: number, max: number, maxBytes: number) => {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new Error(`${name} must contain ${min}..${max} strings`)
  for (const item of value) text(item, name, maxBytes)
}
const branchName = (value: unknown) => {
  if (typeof value !== 'string' || !value || value.length > 200 || !/^[A-Za-z0-9._/-]+$/.test(value) || value.includes('..') || value.startsWith('/') || value.endsWith('/')) throw new Error('branch must be a safe git branch name')
}
const sessionId = (value: unknown) => {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error('sessionId must be a UUID')
}
export function planInputError(value: unknown): string | undefined {
  if (!recordObject(value)) return 'plan must be an object'
  if (value.version !== 1) return 'plan.version must be 1'
  if (typeof value.rationale !== 'string' || Buffer.byteLength(value.rationale) > 2048) return 'plan.rationale exceeds 2048 bytes'
  if (value.sharedNotes !== undefined && (typeof value.sharedNotes !== 'string' || Buffer.byteLength(value.sharedNotes) > 4096)) return 'plan.sharedNotes exceeds 4096 bytes'
  if (!Array.isArray(value.subtasks) || !value.subtasks.length || value.subtasks.length > 6) return 'plan.subtasks must contain 1..6 items'
  const ids = new Set<string>()
  for (const [index, subtask] of value.subtasks.entries()) {
    if (!recordObject(subtask)) return `plan.subtasks[${index}] must be an object`
    if (typeof subtask.id !== 'string' || !/^st-[1-9][0-9]{0,2}$/.test(subtask.id) || ids.has(subtask.id)) return `plan.subtasks[${index}].id is invalid or duplicated`
    ids.add(subtask.id)
    if (typeof subtask.title !== 'string' || !subtask.title || [...subtask.title].length > 120) return `plan.subtasks[${index}].title exceeds 120 characters`
    if (typeof subtask.objective !== 'string' || !subtask.objective || Buffer.byteLength(subtask.objective) > 4096) return `plan.subtasks[${index}].objective exceeds 4096 bytes`
    if (!Array.isArray(subtask.writeSet) || !subtask.writeSet.length || subtask.writeSet.length > 64) return `plan.subtasks[${index}].writeSet must contain 1..64 paths`
    for (const path of subtask.writeSet) { try { relativePath(path, 'writeSet') } catch { return `plan.subtasks[${index}].writeSet contains an invalid path` } }
    if (subtask.readHints !== undefined) {
      if (!Array.isArray(subtask.readHints) || subtask.readHints.length > 64) return `plan.subtasks[${index}].readHints must contain at most 64 paths`
      for (const path of subtask.readHints) { try { relativePath(path, 'readHints') } catch { return `plan.subtasks[${index}].readHints contains an invalid path` } }
    }
    if (subtask.dependsOn !== undefined) {
      if (!Array.isArray(subtask.dependsOn) || subtask.dependsOn.length > 6 || !subtask.dependsOn.every(item => typeof item === 'string')) return `plan.subtasks[${index}].dependsOn must contain at most 6 ids`
    }
    if (!recordObject(subtask.acceptance) || !Array.isArray(subtask.acceptance.commands) || !subtask.acceptance.commands.length || subtask.acceptance.commands.length > 8) return `plan.subtasks[${index}].acceptance.commands must contain 1..8 commands`
    for (const command of subtask.acceptance.commands) if (typeof command !== 'string' || !command.trim() || Buffer.byteLength(command) > 1024) return `plan.subtasks[${index}].acceptance.commands contains an invalid command`
  }
  for (const [index, subtask] of value.subtasks.entries()) {
    if (subtask.dependsOn === undefined) continue
    if (!subtask.dependsOn.every((id: unknown) => typeof id === 'string' && ids.has(id) && id !== subtask.id)) return `plan.subtasks[${index}].dependsOn must reference other subtask ids`
  }
  return undefined
}
export function assertPlanInput(value: unknown): asserts value is PlanInput {
  const error = planInputError(value)
  if (error) throw new Error(error)
}
function validatePlanRecorded(data: Record<string, unknown>) {
  if (!safeId(data.planId)) throw new Error('planId is invalid')
  integer(data.planVersion, 'planVersion', 1)
  oneOf(data.source, new Set(['file', 'model']), 'plan.source')
  if (data.plannerSessionId !== undefined) sessionId(data.plannerSessionId)
  assertPlanInput(data.plan)
  const validation = record(data.validation, 'plan.validation')
  if (validation.ok === true) {
    if (!Array.isArray(validation.waves) || !validation.waves.length) throw new Error('plan.validation.waves is required')
    for (const wave of validation.waves) stringList(wave, 'plan.validation.wave', 1, 6, 128)
  } else if (validation.ok === false) stringList(validation.errors, 'plan.validation.errors', 1, 64, 512)
  else throw new Error('plan.validation.ok must be boolean')
}
function validateRootStart(data: Record<string, unknown>) {
  text(data.goal, 'goal', 4096)
  text(data.repository, 'repository', 1024)
  sha(data.baseCommit, 'baseCommit')
  const config = record(data.config, 'config')
  oneOf(config.mode, new Set(['auto', 'single', 'parallel']), 'config.mode')
  integer(config.maxWorkers, 'config.maxWorkers', 1)
  integer(config.maxSubtasks, 'config.maxSubtasks', 1)
  integer(config.maxAttemptsPerSubtask, 'config.maxAttemptsPerSubtask', 1)
  const budget = record(data.budget, 'budget')
  for (const key of ['maxModelRequests', 'maxTotalTokens', 'maxWallMs', 'maxToolCalls', 'fixReserveTokens']) integer(budget[key], `budget.${key}`, 1)
  if (typeof budget.plannerShare !== 'number' || !Number.isFinite(budget.plannerShare) || budget.plannerShare < 0 || budget.plannerShare > 1) throw new Error('budget.plannerShare is invalid')
  integer(budget.maxInFlightRequests, 'budget.maxInFlightRequests', 1)
  if (budget.maxUsd !== undefined && (typeof budget.maxUsd !== 'number' || !Number.isFinite(budget.maxUsd) || budget.maxUsd <= 0)) throw new Error('budget.maxUsd is invalid')
}
function validateAttemptFinished(data: Record<string, unknown>) {
  if (!safeId(data.attemptId)) throw new Error('attemptId is invalid')
  oneOf(data.outcome, OUTCOMES, 'outcome')
  const run = record(data.run, 'run')
  if (run.sessionId !== undefined) sessionId(run.sessionId)
  text(run.status, 'run.status', 64)
  optionalText(run.stopReason, 'run.stopReason', 64)
  const code = record(data.code, 'code')
  if (code.commit !== undefined) sha(code.commit, 'code.commit')
  if (code.tree !== undefined) sha(code.tree, 'code.tree')
  pathList(code.changedFiles, 'code.changedFiles', 0, 10_000)
  pathList(code.scopeViolations, 'code.scopeViolations', 0, 10_000)
  if (data.resultRef !== undefined) ref(data.resultRef, 'resultRef')
  optionalText(data.detail, 'detail', 1024)
  if (data.outcome === 'succeeded' && (code.commit === undefined || code.tree === undefined || !(code.changedFiles as unknown[]).length || (code.scopeViolations as unknown[]).length))
    throw new Error('succeeded attempt requires a commit/tree, changed files and no scope violations')
  if (data.outcome === 'no_changes' && (code.changedFiles as unknown[]).length) throw new Error('no_changes attempt cannot report changed files')
  if (data.outcome === 'scope_violation' && !(code.scopeViolations as unknown[]).length) throw new Error('scope_violation attempt must list violations')
}
export function validateOrchestrationData(type: OrchEventType, data: Record<string, unknown>) {
  switch (type) {
    case 'root/start': validateRootStart(data); break
    case 'plan/recorded': validatePlanRecorded(data); break
    case 'plan/decision': {
      integer(data.planVersion, 'planVersion', 1)
      oneOf(data.mode, new Set(['single', 'parallel']), 'mode')
      text(data.reason, 'reason', 1024)
      if (!Array.isArray(data.waves) || !data.waves.length) throw new Error('waves is required')
      for (const wave of data.waves) stringList(wave, 'wave', 1, 6, 128)
      break
    }
    case 'attempt/planned': {
      if (!safeId(data.attemptId) || !safeId(data.subtaskId)) throw new Error('attempt id is invalid')
      integer(data.epoch, 'epoch', 1); integer(data.wave, 'wave', 0); sha(data.baseCommit, 'baseCommit')
      const budget = record(data.budget, 'budget')
      for (const key of ['maxModelRequests', 'maxToolCalls', 'maxTotalTokens']) integer(budget[key], `budget.${key}`, 1)
      break
    }
    case 'attempt/started': {
      if (!safeId(data.attemptId)) throw new Error('attemptId is invalid')
      text(data.worktree, 'worktree', 1024); branchName(data.branch); text(data.sessionDirectory, 'sessionDirectory', 1024)
      break
    }
    case 'attempt/session': if (!safeId(data.attemptId)) throw new Error('attemptId is invalid'); sessionId(data.sessionId); break
    case 'attempt/finished': validateAttemptFinished(data); break
    case 'attempt/late': if (!safeId(data.attemptId)) throw new Error('attemptId is invalid'); text(data.summary, 'summary', 2048); break
    case 'integration/started': if (!safeId(data.integrationId)) throw new Error('integrationId is invalid'); integer(data.wave, 'wave', 0); sha(data.baseCommit, 'baseCommit'); break
    case 'integration/applied': if (!safeId(data.integrationId) || !safeId(data.attemptId)) throw new Error('integration/attempt id is invalid'); sha(data.sourceCommit, 'sourceCommit'); sha(data.commit, 'commit'); break
    case 'integration/conflict': if (!safeId(data.integrationId) || !safeId(data.attemptId)) throw new Error('integration/attempt id is invalid'); pathList(data.files, 'files', 1, 10_000); break
    case 'integration/finished': if (!safeId(data.integrationId)) throw new Error('integrationId is invalid'); sha(data.head, 'head'); sha(data.tree, 'tree'); break
    case 'verification/finished': {
      sha(data.head, 'head'); sha(data.tree, 'tree'); text(data.command, 'command', 1024)
      if (data.exitCode !== null) integer(data.exitCode, 'exitCode')
      if (data.logRef !== undefined) ref(data.logRef, 'logRef')
      break
    }
    case 'human/requested': {
      if (!safeId(data.requestId)) throw new Error('requestId is invalid')
      oneOf(data.kind, HUMAN_KINDS, 'kind'); text(data.prompt, 'prompt', 4096)
      stringList(data.options, 'options', 1, 8, 200)
      if (data.attemptId !== undefined && !safeId(data.attemptId)) throw new Error('attemptId is invalid')
      break
    }
    case 'human/resolved': if (!safeId(data.requestId)) throw new Error('requestId is invalid'); text(data.choice, 'choice', 200); optionalText(data.note, 'note', 1024); if (data.actor !== 'local-user') throw new Error('human/resolved actor must be local-user'); break
    case 'approval/requested': {
      if (!safeId(data.requestId) || !safeId(data.attemptId)) throw new Error('approval request/attempt id is invalid')
      text(data.tool, 'tool', 64)
      if (!sha256(data.summaryHash)) throw new Error('approval summaryHash must be a sha256 hex digest')
      if (data.writeSet !== undefined) pathList(data.writeSet, 'writeSet', 0, 64)
      break
    }
    case 'approval/resolved': {
      if (!safeId(data.requestId) || !safeId(data.attemptId)) throw new Error('approval request/attempt id is invalid')
      text(data.tool, 'tool', 64)
      if (typeof data.allowed !== 'boolean') throw new Error('approval allowed must be boolean')
      oneOf(data.source, new Set(['auto', 'user', 'timeout', 'cancelled']), 'approval source')
      break
    }
    case 'control/stop': oneOf(data.scope, new Set(['accepting', 'dispatch', 'running']), 'scope'); text(data.reason, 'reason', 512); break
    case 'root/finish': oneOf(data.status, TERMINAL, 'status'); if (data.reportRef !== undefined) ref(data.reportRef, 'reportRef'); break
    case 'group/start': case 'group/budget-reserved': case 'group/model-dispatched': case 'group/reservation-released': case 'group/usage-unknown': case 'group/budget-settled': case 'group/tool-admitted':
      validatePayload(type, data)
      break
  }
}
export function validateOrchestrationEvent(value: unknown, rootId: string, expectedSeq: number): asserts value is OrchestrationEventUnion {
  if (!recordObject(value)) throw new Error('orchestration event must be an object')
  if (value.v !== 1) throw new Error(`unsupported orchestration log version: ${String(value.v)}`)
  if (value.rootId !== rootId || typeof value.rootId !== 'string') throw new Error('orchestration root scope mismatch')
  if (value.seq !== expectedSeq) throw new Error('orchestration sequence mismatch')
  if (!safeId(value.id)) throw new Error('orchestration event id is invalid')
  if (typeof value.at !== 'string' || Number.isNaN(Date.parse(value.at))) throw new Error('orchestration event timestamp is invalid')
  if (typeof value.type !== 'string' || !(value.type in EVENT_TYPES)) throw new Error(`unknown orchestration event type: ${String(value.type)}`)
  if (!recordObject(value.data)) throw new Error('orchestration event data must be an object')
  validateOrchestrationData(value.type as OrchEventType, value.data)
}
// 事件名的白名单只在这里维护一次；未知类型必须拒绝，不能把未来的事件当成普通数据静默折叠。
const EVENT_TYPES: Record<OrchEventType, true> = {
  'root/start': true, 'plan/recorded': true, 'plan/decision': true, 'attempt/planned': true, 'attempt/started': true,
  'attempt/session': true, 'attempt/finished': true, 'attempt/late': true, 'integration/started': true,
  'integration/applied': true, 'integration/conflict': true, 'integration/finished': true, 'verification/finished': true,
  'human/requested': true, 'human/resolved': true, 'approval/requested': true, 'approval/resolved': true,
  'control/stop': true, 'root/finish': true, 'group/start': true,
  'group/budget-reserved': true, 'group/model-dispatched': true, 'group/reservation-released': true,
  'group/usage-unknown': true, 'group/budget-settled': true, 'group/tool-admitted': true,
}
export const ORCHESTRATION_EVENT_TYPES = Object.freeze(Object.keys(EVENT_TYPES) as OrchEventType[])
export function decodeOrchestrationLog(text: string, rootId: string): OrchestrationEventUnion[] {
  if (text && !text.endsWith('\n')) throw new Error('incomplete orchestration JSONL tail; preserve and quarantine before recovery')
  const lines = text.split('\n').slice(0, -1)
  const events: OrchestrationEventUnion[] = []
  const ids = new Set<string>()
  for (const [index, line] of lines.entries()) {
    let value: unknown
    try { value = JSON.parse(line) } catch (error) { throw new Error(`corrupt orchestration JSONL record ${index + 1}`, { cause: error }) }
    validateOrchestrationEvent(value, rootId, index + 1)
    if (ids.has(value.id)) throw new Error(`duplicate orchestration event id at ${index + 1}`)
    ids.add(value.id)
    events.push(value)
  }
  return events
}
