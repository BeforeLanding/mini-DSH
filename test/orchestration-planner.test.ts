import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ChatResponse } from '../src/core/contracts.js'
import { TaskGroupBudgetCoordinator } from '../src/core/task-group-budget.js'
import type { GroupBudgetEvent, GroupJournal } from '../src/core/task-group-budget.js'
import { inspectSession } from '../src/core/session-inspect.js'
import { parsePlannerPlan, runPlanner } from '../src/orchestration/planner.js'
import { newRootId } from '../src/orchestration/store.js'
import { worktreeLayout } from '../src/orchestration/worktrees.js'

const usage = { inputTokens: 100, outputTokens: 10, totalTokens: 110, source: 'provider' as const, uncertain: false }
const planText = '```json\n{"version":1,"rationale":"one module","subtasks":[{"id":"st-1","title":"implement a","objective":"write a","writeSet":["src/a.mjs"],"acceptance":{"commands":["node --test"]}}]}\n```'
class MemoryJournal implements GroupJournal {
  events: GroupBudgetEvent[] = []
  read() { return this.events }
  async append(event: GroupBudgetEvent) { this.events.push(event) }
}
async function workspace(t: import('node:test').TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-planner-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const repo = path.join(root, 'repo'), layout = worktreeLayout(path.join(root, 'orch'))
  await fs.mkdir(repo)
  await fs.writeFile(path.join(repo, 'readme.md'), 'base\n')
  return { repo, layout }
}
function scripted(contents: string[]) {
  let index = 0
  return {
    provider: 'scripted', model: 'test', capabilities: { test: { contextWindowTokens: 100_000 } },
    chat: async (): Promise<ChatResponse> => ({ usage, content: contents[Math.min(index++, contents.length - 1)]!, complete: true, finishReason: 'stop' }),
  }
}
async function plannerInput(t: import('node:test').TestContext, contents: string[]) {
  const { repo, layout } = await workspace(t)
  const group = await TaskGroupBudgetCoordinator.openJournal(new MemoryJournal(), {
    maxModelRequests: 8, maxToolCalls: 16, maxTotalTokens: 200_000, rootTokenFloor: 0, rootRequestFloor: 0, maxWallDurationMs: 60_000,
  })
  return {
    input: {
      goal: 'implement src/a.mjs', rootId: newRootId(), worktree: repo, layout, adapter: scripted(contents), model: 'scripted/test',
      rootGroup: group, budget: { maxModelRequests: 8, maxToolCalls: 16, maxTotalTokens: 200_000 },
      signal: new AbortController().signal, maxSubtasks: 4, protectedPaths: ['.git/', '.mini-dsh/'],
    },
    layout,
  }
}

test('a read-only planner runs in the base snapshot and corrects one invalid plan', async t => {
  const { input, layout } = await plannerInput(t, ['I could not decide.', planText])
  const outcome = await runPlanner(input)
  assert.equal(outcome.plan.subtasks.length, 1)
  assert.equal(outcome.plan.subtasks[0]!.id, 'st-1')
  const sessionDirectory = path.join(layout.root, 'sessions', 'planner', outcome.sessionId, 'events.jsonl')
  const inspection = await inspectSession(sessionDirectory)
  assert.equal(inspection.integrity.complete, true)
  assert.equal(inspection.session.id, outcome.sessionId)
  const events = await fs.readFile(sessionDirectory, 'utf8')
  assert.match(events, /"source":"orchestrator"/)
  assert.match(events, /"planner":true/)
})

test('a planner that returns no usable plan twice fails with the validation error', async t => {
  const { input } = await plannerInput(t, ['no plan', 'still no plan'])
  await assert.rejects(runPlanner(input), /invalid plan twice/)
})

test('planner output parsing accepts fenced or bare JSON and reports structural errors', () => {
  assert.equal(parsePlannerPlan(planText).plan?.subtasks[0]?.id, 'st-1')
  const bare = '{"version":1,"rationale":"r","subtasks":[{"id":"st-1","title":"t","objective":"o","writeSet":["a"],"acceptance":{"commands":["node --test"]}}]}'
  assert.equal(parsePlannerPlan(bare).plan?.subtasks.length, 1)
  const invalid = parsePlannerPlan('```json\n{"version":2,"rationale":"r","subtasks":[]}\n```')
  assert.match(invalid.error ?? '', /version must be 1/)
  assert.equal(parsePlannerPlan('no json').plan, undefined)
})
