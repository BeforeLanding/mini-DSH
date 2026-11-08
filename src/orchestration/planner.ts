import path from 'node:path'
import { createHarness } from '../app/create-harness.js'
import type { HarnessAdapter } from '../app/create-harness.js'
import { CLI_BUDGET } from '../core/budget.js'
import type { BudgetPolicy } from '../core/budget.js'
import { JsonlStore } from '../core/event-store.js'
import { utf8Prefix } from '../core/tool-result-store.js'
import type { TaskGroupBudgetCoordinator } from '../core/task-group-budget.js'
import type { AttemptBudget, PlanInput } from './contracts.js'
import { planInputError } from './validation.js'
import type { WorktreeLayout } from './worktrees.js'

// planner 与 worker 一样是一次普通的 createHarness，只是角色为只读：没有 Bash、没有写工具、
// 没有 MCP 与委派。它只读基线快照 worktree，提出计划；计划是否可用由宿主校验（plan.ts）。
export interface PlannerInput {
  goal: string
  rootId: string
  worktree: string
  layout: WorktreeLayout
  adapter: HarnessAdapter
  model: string
  rootGroup: TaskGroupBudgetCoordinator
  budget: AttemptBudget
  signal: AbortSignal
  maxSubtasks: number
  protectedPaths: readonly string[]
  onSession?: (sessionId: string) => void | Promise<void>
}
export interface PlannerOutcome {
  plan: PlanInput
  sessionId: string
  requests: number
  tokens: number
}
const REPAIR_LIMIT = 2 * 1024
const bounded = (text: string, limit: number) => Buffer.byteLength(text) <= limit ? text : utf8Prefix(Buffer.from(text), limit).toString('utf8')

export function plannerGuidance(input: Pick<PlannerInput, 'goal' | 'maxSubtasks' | 'protectedPaths'>) {
  return `You are the read-only planner of a host-driven multi-agent orchestration. Inspect the repository and propose a plan. The host validates the plan and runs one worker per subtask in isolated git worktrees; it commits, integrates and verifies. You cannot edit files, run commands, use MCP or delegate.

Root goal:
${input.goal}

Constraints:
- Return 1..${input.maxSubtasks} subtasks. Prefer the smallest split that gives independent, verifiable work; one subtask is valid when the change is cohesive.
- id is st-1, st-2, ...; title <= 120 characters; objective <= 4 KiB.
- writeSet contains repository-relative paths or directory prefixes ending in "/". No absolute paths, no "..", no duplicate entries.
- Subtasks in the same dependency wave must have disjoint write sets. Paths may overlap only when one subtask depends on the other (later waves start from the integrated result).
- Protected paths must not appear in any write set: ${input.protectedPaths.join(', ')}.
- dependsOn references other subtask ids and must form a DAG.
- acceptance.commands must be nonempty, runnable from the repository root, and pass the workspace command gate. They must check externally fixable behavior.
- End your final message with exactly one JSON code block in this shape:
\`\`\`json
{"version":1,"rationale":"why this split","sharedNotes":"optional cross-subtask interface notes","subtasks":[{"id":"st-1","title":"...","objective":"...","writeSet":["src/a.mjs"],"dependsOn":[],"acceptance":{"commands":["node --test"]}}]}
\`\`\``
}
export function renderPlannerTask(goal: string) {
  return `Plan the root goal below. Explore the repository with the read tools first. Reply with exactly one fenced JSON plan block.\n\n${goal}`
}

export function parsePlannerPlan(text: string): { plan?: PlanInput; error?: string } {
  const blocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)]
  const candidates = blocks.length ? [...blocks].reverse().map(match => match[1]!.trim()) : [text.trim()]
  let error = 'planner response does not contain a JSON plan'
  for (const candidate of candidates) {
    let value: unknown
    try { value = JSON.parse(candidate) } catch { continue }
    const invalid = planInputError(value)
    if (invalid) { error = invalid; continue }
    return { plan: value as PlanInput }
  }
  return { error }
}

function correctionPrompt(error: string) {
  return bounded(`Your plan was rejected: ${error}. Return the corrected plan as exactly one fenced JSON code block. Follow every constraint in the original instructions.`, REPAIR_LIMIT)
}

function finalContent(events: readonly { type: string; data: unknown }[]) {
  const message = [...events].reverse().find(event => event.type === 'assistant/message')
  return (message?.data as { content?: string | null } | undefined)?.content ?? ''
}

export async function runPlanner(input: PlannerInput): Promise<PlannerOutcome> {
  const capacity = input.adapter.capabilities?.[input.adapter.model]?.contextWindowTokens
  if (capacity === undefined) throw new Error('planner model context capacity must be explicitly configured')
  const goal = bounded(input.goal, 4096)
  const harness = await createHarness({
    workspace: input.worktree, profile: 'coding', adapter: input.adapter, parentTaskGroup: input.rootGroup,
    agentRole: 'planner', delegation: { mode: 'off' }, autoApprove: false,
    contextLayout: 'frozen', runtimeClockMode: 'frozen',
    hostGuidance: plannerGuidance({ goal, maxSubtasks: input.maxSubtasks, protectedPaths: input.protectedPaths }),
  })
  try {
    const session = harness.root.sessions.create({ source: 'orchestrator', workspace: input.worktree, rootId: input.rootId, planner: true })
    const store = await JsonlStore.open(path.join(input.layout.root, 'sessions', 'planner'), session.id)
    try { harness.root.sessions.attachStore(session.id, store) } catch (error) { await store.close(); throw error }
    await harness.root.sessions.flush(session.id)
    await input.onSession?.(session.id)
    const policy: BudgetPolicy = {
      ...CLI_BUDGET, maxModelRequests: Math.min(16, input.budget.maxModelRequests), maxToolCalls: Math.min(32, input.budget.maxToolCalls),
      maxTotalTokens: input.budget.maxTotalTokens, contextWindowTokens: capacity,
    }
    const agent = harness.root.agents.create({ name: 'planner', sessionId: session.id, model: input.model, loop: harness.root.agentLoop, budget: policy })
    await agent.send(renderPlannerTask(goal), { signal: input.signal })
    let parsed = parsePlannerPlan(finalContent(harness.root.sessions.visibleEvents(session.id)))
    if (!parsed.plan) {
      await agent.send(correctionPrompt(parsed.error ?? 'invalid plan'), { signal: input.signal })
      parsed = parsePlannerPlan(finalContent(harness.root.sessions.visibleEvents(session.id)))
    }
    await harness.root.sessions.flush(session.id)
    if (!parsed.plan) throw new Error(`planner returned an invalid plan twice: ${bounded(parsed.error ?? 'unknown error', 512)}`)
    const state = harness.root.sessions.latestRun(session.id)
    return { plan: parsed.plan, sessionId: session.id, requests: state?.counters.modelRequests ?? 0, tokens: state?.counters.totalTokens ?? 0 }
  } finally {
    try { await harness.root.sessions.close() } finally { await harness.dispose() }
  }
}
