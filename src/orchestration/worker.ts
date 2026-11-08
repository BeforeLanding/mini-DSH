import path from 'node:path'
import { createHarness } from '../app/create-harness.js'
import type { HarnessAdapter } from '../app/create-harness.js'
import { CLI_BUDGET } from '../core/budget.js'
import type { BudgetPolicy } from '../core/budget.js'
import { JsonlStore } from '../core/event-store.js'
import { utf8Prefix } from '../core/tool-result-store.js'
import type { ApprovalRequest } from '../core/contracts.js'
import type { CommandOptions, CommandResult } from '../core/command-runner.js'
import type { TaskGroupBudgetCoordinator } from '../core/task-group-budget.js'
import type { AttemptBudget } from './contracts.js'
import type { WorktreeLayout } from './worktrees.js'

// worker 是一个普通的单 Agent Harness：独立 root、独立 worktree、独立会话目录与审批通道。
// 它没有任何编排或委派工具，工具档位由装配决定，不靠提示词约束。
export interface WorkerAssignment {
  rootGoal: string
  subtaskId: string
  title: string
  objective: string
  writeSet: string[]
  readHints: string[]
  acceptance: { commands: string[] }
  sharedNotes?: string
  baseCommit: string
  planVersion: number
  dependencies?: { subtaskId: string; commit: string; changedFiles: string[]; summary: string }[]
}
export interface WorkerReport {
  status: 'done' | 'needs_input' | 'blocked'
  summary: string
  uncertainties: string[]
  sources: { path: string; blob?: string }[]
  valid: boolean
  truncated: boolean
}
export interface WorkerOutcome {
  sessionId: string
  runStatus: string
  stopReason?: string
  finalContent: string
  report: WorkerReport
  usage: { requests: number; tokens: number; cacheReadTokens: number }
  error?: string
}
const REPORT_LIMIT = 8 * 1024
const SUMMARY_LIMIT = 2 * 1024
const bounded = (text: string, limit: number) => Buffer.byteLength(text) <= limit ? text : utf8Prefix(Buffer.from(text), limit).toString('utf8')
export function parseWorkerReport(text: string): WorkerReport {
  const truncated = Buffer.byteLength(text) > REPORT_LIMIT
  const source = truncated ? bounded(text, REPORT_LIMIT) : text
  const blocks = [...source.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)]
  let value: unknown
  for (const block of blocks.reverse()) {
    try { value = JSON.parse(block[1]!.trim()); break } catch { /* try the previous block */ }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { status: 'done', summary: '', uncertainties: [], sources: [], valid: false, truncated }
  const record = value as Record<string, unknown>
  const status = record.status
  if (status !== 'done' && status !== 'needs_input' && status !== 'blocked') return { status: 'done', summary: '', uncertainties: [], sources: [], valid: false, truncated }
  if (typeof record.summary !== 'string') return { status, summary: '', uncertainties: [], sources: [], valid: false, truncated }
  const uncertainties = Array.isArray(record.uncertainties) && record.uncertainties.length <= 16 && record.uncertainties.every(item => typeof item === 'string') ? record.uncertainties as string[] : []
  const sources = Array.isArray(record.sources) && record.sources.length <= 32 ? record.sources.flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof (item as { path?: unknown }).path !== 'string') return []
    const source = item as { path: string; blob?: unknown }
    return [{ path: source.path, ...(typeof source.blob === 'string' ? { blob: source.blob } : {}) }]
  }) : []
  const summary = bounded([...record.summary].length > 0 ? record.summary : '', SUMMARY_LIMIT)
  return { status, summary, uncertainties, sources, valid: true, truncated: truncated || summary.length < [...record.summary].length }
}
export function workerGuidance(assignment: WorkerAssignment) {
  const writeSet = assignment.writeSet.map(item => `- ${item}`).join('\n')
  const hints = assignment.readHints.length ? `\nSuggested reads:\n${assignment.readHints.map(item => `- ${item}`).join('\n')}` : ''
  const notes = assignment.sharedNotes?.trim() ? `\nShared notes from the plan:\n${assignment.sharedNotes.trim()}\n` : ''
  const dependencies = assignment.dependencies?.length
    ? `\nAlready integrated dependencies:\n${assignment.dependencies.map(item => `- ${item.subtaskId} @ ${item.commit}: ${item.summary} (${item.changedFiles.join(', ')})`).join('\n')}\n`
    : ''
  const acceptance = assignment.acceptance.commands.map(item => `- ${item}`).join('\n')
  return `You are a worker in a host-driven multi-agent orchestration. The host created this git worktree and will commit and integrate your changes. The root goal is:
${assignment.rootGoal}

Your subtask ${assignment.subtaskId} — ${assignment.title}:
${assignment.objective}

Write set (only these paths may change; the host checks this afterwards):
${writeSet}${hints}${notes}${dependencies}
Acceptance commands (run them if useful; the host re-runs them on the integrated branch):
${acceptance}

Rules:
- Do not run git commit, git checkout, git branch, or git worktree. The host owns them.
- Do not modify anything outside the write set. Work only inside this worktree.
- End your final message with exactly one JSON code block:
\`\`\`json
{"status":"done","summary":"what you changed","uncertainties":[],"sources":[{"path":"relative/path"}]}
\`\`\`
  Use "needs_input" or "blocked" if you cannot complete the task; the host will not integrate in that case.`
}
export function renderAssignment(assignment: WorkerAssignment) {
  return `Goal: ${assignment.rootGoal}\n\nSubtask ${assignment.subtaskId}: ${assignment.title}\n\n${assignment.objective}\n\nWrite set: ${assignment.writeSet.join(', ')}\n\nAcceptance commands:\n${assignment.acceptance.commands.map(item => `- ${item}`).join('\n')}${assignment.sharedNotes ? `\n\nShared notes:\n${assignment.sharedNotes}` : ''}`
}
export interface WorkerInput {
  assignment: WorkerAssignment
  rootId: string
  attemptId: string
  worktree: string
  layout: WorktreeLayout
  adapter: HarnessAdapter
  model: string
  rootGroup: TaskGroupBudgetCoordinator
  budget: AttemptBudget
  signal: AbortSignal
  approve: (request: ApprovalRequest) => Promise<boolean>
  onSession: (sessionId: string) => Promise<void>
  commandRunner?: (options: CommandOptions) => Promise<CommandResult>
  approvalTimeoutMs?: number
}
export async function runWorker(input: WorkerInput): Promise<WorkerOutcome> {
  const capacity = input.adapter.capabilities?.[input.adapter.model]?.contextWindowTokens
  if (capacity === undefined) throw new Error('worker model context capacity must be explicitly configured')
  const harness = await createHarness({
    workspace: input.worktree, profile: 'coding', adapter: input.adapter, parentTaskGroup: input.rootGroup,
    agentRole: 'coordinator', delegation: { mode: 'off' }, autoApprove: false,
    contextLayout: 'frozen', runtimeClockMode: 'frozen', hostGuidance: workerGuidance(input.assignment),
    ...(input.commandRunner ? { commandRunner: input.commandRunner } : {}),
  })
  let store: JsonlStore | undefined
  const disposeApprover = harness.root.sandbox.setApprover(input.approve)
  try {
    const session = harness.root.sessions.create({
      source: 'orchestrator', workspace: input.worktree, rootId: input.rootId, attemptId: input.attemptId,
      subtaskId: input.assignment.subtaskId, groupId: input.rootGroup.start.groupId, planVersion: input.assignment.planVersion,
    })
    store = await JsonlStore.open(path.join(input.layout.root, 'sessions', input.attemptId), session.id)
    try { harness.root.sessions.attachStore(session.id, store) } catch (error) { await store.close(); throw error }
    await harness.root.sessions.flush(session.id)
    await input.onSession(session.id)
    const budget: BudgetPolicy = {
      ...CLI_BUDGET, maxModelRequests: input.budget.maxModelRequests, maxToolCalls: input.budget.maxToolCalls,
      maxTotalTokens: input.budget.maxTotalTokens, contextWindowTokens: capacity,
      approvalTimeoutMs: input.approvalTimeoutMs ?? CLI_BUDGET.approvalTimeoutMs,
    }
    const agent = harness.root.agents.create({ name: `worker-${input.assignment.subtaskId}`, sessionId: session.id, model: input.model, loop: harness.root.agentLoop, budget })
    let runError: unknown
    try { await agent.send(renderAssignment(input.assignment), { signal: input.signal }) } catch (error) { runError = error }
    await harness.root.sessions.flush(session.id).catch(() => {})
    const state = harness.root.sessions.latestRun(session.id)
    const events = harness.root.sessions.visibleEvents(session.id)
    const finalContent = [...events].reverse().find(event => event.type === 'assistant/message')?.data.content ?? ''
    return {
      sessionId: session.id,
      runStatus: state?.status ?? 'error',
      ...(state?.status !== undefined && state.status !== 'running' ? { stopReason: state.status } : {}),
      finalContent,
      report: parseWorkerReport(finalContent),
      usage: { requests: state?.counters.modelRequests ?? 0, tokens: state?.counters.totalTokens ?? 0, cacheReadTokens: state?.counters.cacheReadTokens ?? 0 },
      ...(runError ? { error: bounded(runError instanceof Error ? runError.message : String(runError), 1024) } : {}),
    }
  } finally {
    disposeApprover()
    try { await harness.root.sessions.close() } finally { await harness.dispose() }
  }
}
