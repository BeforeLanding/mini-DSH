import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ChatRequest, ChatResponse, ToolCall } from '../src/core/contracts.js'
import { commitAll, git, headCommit, stageAll, statusPorcelain } from '../src/orchestration/git.js'
import { orchestrate, resumeOrchestrate } from '../src/orchestration/orchestrator.js'
import { crashAt } from '../src/orchestration/faults.js'
import { loadOrchestration } from '../src/orchestration/inspect.js'
import type { PlanInput } from '../src/orchestration/contracts.js'

const usage = { inputTokens: 100, outputTokens: 10, totalTokens: 110, source: 'provider' as const, uncertain: false }
let nextCall = 0
const write = (target: string, content: string): ToolCall => ({ id: `recover-call-${++nextCall}`, name: 'write_file', arguments: { path: target, content } })
const report = (target: string) => `\`\`\`json\n${JSON.stringify({ status: 'done', summary: `wrote ${target}`, uncertainties: [], sources: [{ path: target }] })}\n\`\`\``
const plan = (subtasks: PlanInput['subtasks']): PlanInput => ({ version: 1, rationale: 'recovery fixture', subtasks })
const single: PlanInput = plan([{ id: 'st-1', title: 'write a', objective: 'create src/a.txt', writeSet: ['src/a.txt'], acceptance: { commands: ['node check-a.mjs'] } }])
const pair: PlanInput = plan([
  { id: 'st-1', title: 'write a', objective: 'create src/a.txt', writeSet: ['src/a.txt'], acceptance: { commands: ['node check-a.mjs'] } },
  { id: 'st-2', title: 'write b', objective: 'create src/b.txt', writeSet: ['src/b.txt'], acceptance: { commands: ['node check-b.mjs'] } },
])
async function repository(t: import('node:test').TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-recover-'))
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }) })
  const repo = path.join(root, 'repo')
  await fs.mkdir(repo)
  await git(repo, ['init', '--quiet'])
  await git(repo, ['config', 'core.autocrlf', 'false'])
  for (const name of ['a', 'b'])
    await fs.writeFile(path.join(repo, `check-${name}.mjs`), `import fs from 'node:fs'\nconst text = fs.readFileSync(new URL('./src/${name}.txt', import.meta.url), 'utf8')\nif (text !== '${name}\\n') { console.error('FAIL'); process.exit(1) }\nconsole.log('PASS')\n`)
  await fs.writeFile(path.join(repo, 'base.txt'), 'base\n')
  await stageAll(repo)
  const baseCommit = await commitAll(repo, 'initial')
  return { root, repo, baseCommit, baseDirectory: path.join(root, 'orch') }
}
function scripted(calls: { count: number }) {
  const writes: Record<string, [string, string]> = { 'st-1': ['src/a.txt', 'a\n'], 'st-2': ['src/b.txt', 'b\n'] }
  return {
    provider: 'scripted', model: 'test', capabilities: { test: { contextWindowTokens: 100_000 } },
    chat: async (request: ChatRequest): Promise<ChatResponse> => {
      calls.count++
      const text = (request.messages ?? []).map(message => typeof message.content === 'string' ? message.content : '').join('\n')
      const id = text.includes('Subtask st-2') ? 'st-2' : 'st-1'
      const [target, content] = writes[id]!
      return (request.messages ?? []).some(message => message.role === 'tool')
        ? { usage, content: report(target), complete: true, finishReason: 'stop' }
        : { usage, toolCalls: [write(target, content)], complete: true }
    },
  }
}
function runOptions(repo: string, baseDirectory: string, adapter: ReturnType<typeof scripted>, selected: PlanInput, extra: Record<string, unknown> = {}) {
  return {
    repository: repo, goal: 'write the files', plan: selected, baseDirectory, adapter, model: 'scripted/test',
    maxWorkers: 2, approval: { writes: 'auto' as const, bash: 'ask' as const, approve: async () => true }, ...extra,
  }
}
function resumeOptions(baseDirectory: string, adapter: ReturnType<typeof scripted>, extra: Record<string, unknown> = {}) {
  return {
    baseDirectory, adapter, model: 'scripted/test',
    approval: { writes: 'auto' as const, bash: 'ask' as const, approve: async () => true }, ...extra,
  }
}
async function worktreeCount(directory: string) {
  return (await fs.readdir(path.join(directory, 'worktrees')).catch(() => [] as string[]))
    .filter(name => name.startsWith('at_')).length
}

test('a completed worker run is adopted after a crash instead of being re-executed', async t => {
  const { repo, baseDirectory, baseCommit } = await repository(t)
  const calls = { count: 0 }
  const crashed = await orchestrate(runOptions(repo, baseDirectory, scripted(calls), single, { faults: crashAt('after-worker-run') }))
  assert.equal(crashed.status, 'failed')
  let reportState = await loadOrchestration(crashed.directory)
  assert.equal(reportState.state.finished, undefined)
  assert.equal(reportState.state.attempts[reportState.state.attemptOrder[0]!]?.status, 'running')
  const callsAtCrash = calls.count
  const resumed = await resumeOrchestrate({ ...resumeOptions(baseDirectory, scripted(calls)), rootId: crashed.rootId })
  assert.equal(resumed.status, 'completed', resumed.error)
  assert.equal(calls.count, callsAtCrash, 'resume must adopt the completed run without provider calls')
  reportState = await loadOrchestration(resumed.directory)
  assert.equal(reportState.state.attemptOrder.length, 1)
  assert.equal(reportState.state.attempts[reportState.state.attemptOrder[0]!]?.outcome, 'succeeded')
  assert.equal(await worktreeCount(resumed.directory), 1)
  assert.equal(reportState.state.verifications[0]?.exitCode, 0)
  assert.equal(await headCommit(repo), baseCommit)
  assert.deepEqual(await statusPorcelain(repo), [])
})

test('a crash after cherry-pick replays the integration from its recorded base', async t => {
  const { repo, baseDirectory } = await repository(t)
  const calls = { count: 0 }
  const crashed = await orchestrate(runOptions(repo, baseDirectory, scripted(calls), single, { faults: crashAt('after-cherry-pick') }))
  const callsAtCrash = calls.count
  let state = await loadOrchestration(crashed.directory)
  assert.equal(state.state.integration?.status, 'started')
  assert.equal(state.state.integration?.applied.length, 0)
  const resumed = await resumeOrchestrate({ ...resumeOptions(baseDirectory, scripted(calls)), rootId: crashed.rootId })
  assert.equal(resumed.status, 'completed', resumed.error)
  assert.equal(calls.count, callsAtCrash)
  state = await loadOrchestration(resumed.directory)
  assert.equal(state.state.integrations.length, 2)
  assert.equal(state.state.integrations[0]?.status, 'finished')
  assert.deepEqual(state.state.integrations[1]?.applied.map(item => state.state.attempts[item.attemptId]?.subtaskId), ['st-1'])
  assert.equal(state.state.verifications[0]?.exitCode, 0)
})

test('a planned attempt is started in place after a crash before attempt/started', async t => {
  const { repo, baseDirectory } = await repository(t)
  const calls = { count: 0 }
  const crashed = await orchestrate(runOptions(repo, baseDirectory, scripted(calls), single, { faults: crashAt('after-attempt-planned') }))
  assert.equal(calls.count, 0)
  let state = await loadOrchestration(crashed.directory)
  assert.equal(state.state.attempts[state.state.attemptOrder[0]!]?.status, 'planned')
  const resumed = await resumeOrchestrate({ ...resumeOptions(baseDirectory, scripted(calls)), rootId: crashed.rootId })
  assert.equal(resumed.status, 'completed', resumed.error)
  state = await loadOrchestration(resumed.directory)
  assert.equal(state.state.attemptOrder.length, 1)
  assert.equal(state.state.attempts[state.state.attemptOrder[0]!]?.status, 'finished')
  assert.equal(await worktreeCount(resumed.directory), 1)
  assert.ok(calls.count > 0)
})

test('a crash after integration/started re-applies the successful attempt in a new cycle', async t => {
  const { repo, baseDirectory } = await repository(t)
  const calls = { count: 0 }
  const crashed = await orchestrate(runOptions(repo, baseDirectory, scripted(calls), single, { faults: crashAt('after-integration-started') }))
  const resumed = await resumeOrchestrate({ ...resumeOptions(baseDirectory, scripted(calls)), rootId: crashed.rootId })
  assert.equal(resumed.status, 'completed', resumed.error)
  const state = await loadOrchestration(resumed.directory)
  assert.equal(state.state.integrations.length, 2)
  assert.deepEqual(state.state.integrations[1]?.applied.map(item => state.state.attempts[item.attemptId]?.subtaskId), ['st-1'])
  assert.equal(state.state.verifications[0]?.exitCode, 0)
})

test('a crash after a verification command re-runs it because no evidence was recorded', async t => {
  const { repo, baseDirectory } = await repository(t)
  const calls = { count: 0 }
  const crashed = await orchestrate(runOptions(repo, baseDirectory, scripted(calls), single, { faults: crashAt('after-verify-command') }))
  let state = await loadOrchestration(crashed.directory)
  assert.equal(state.state.verifications.length, 0)
  const resumed = await resumeOrchestrate({ ...resumeOptions(baseDirectory, scripted(calls)), rootId: crashed.rootId })
  assert.equal(resumed.status, 'completed', resumed.error)
  state = await loadOrchestration(resumed.directory)
  assert.equal(state.state.verifications.length, 1)
  assert.equal(state.state.verifications[0]?.exitCode, 0)
})

test('an in-flight provider call becomes unknown usage and an interrupted sibling needs a human decision', async t => {
  const { repo, baseDirectory } = await repository(t)
  const calls = { count: 0 }
  let blocked!: () => void
  const blockedPromise = new Promise<void>(resolve => { blocked = resolve })
  let blockedOnce = false
  const writes: Record<string, [string, string]> = { 'st-1': ['src/a.txt', 'a\n'], 'st-2': ['src/b.txt', 'b\n'] }
  const adapter = {
    provider: 'scripted', model: 'test', capabilities: { test: { contextWindowTokens: 100_000 } },
    chat: async (request: ChatRequest): Promise<ChatResponse> => {
      calls.count++
      const text = (request.messages ?? []).map(message => typeof message.content === 'string' ? message.content : '').join('\n')
      const id = text.includes('Subtask st-2') ? 'st-2' : 'st-1'
      const [target, content] = writes[id]!
      const hasTool = (request.messages ?? []).some(message => message.role === 'tool')
      if (id === 'st-2' && !hasTool && !blockedOnce) {
        blockedOnce = true
        blocked()
        await new Promise<void>(() => {})
      }
      if (id === 'st-1' && hasTool) await blockedPromise
      return hasTool
        ? { usage, content: report(target), complete: true, finishReason: 'stop' }
        : { usage, toolCalls: [write(target, content)], complete: true }
    },
  }
  const crashed = await orchestrate(runOptions(repo, baseDirectory, adapter, pair, { faults: crashAt('after-worker-run') }))
  let state = await loadOrchestration(crashed.directory)
  assert.ok(Object.values(state.state.ledger.reservations).some(item => item.status === 'unknown' && item.cause === 'crash'))
  const callsAtCrash = calls.count
  const refused = await resumeOrchestrate({ ...resumeOptions(baseDirectory, adapter), rootId: crashed.rootId })
  assert.equal(refused.status, 'needs_human')
  state = await loadOrchestration(refused.directory)
  assert.ok(Object.values(state.state.human).some(item => item.request.kind === 'budget_extension' && !item.response))
  const accepted = await resumeOrchestrate({ ...resumeOptions(baseDirectory, adapter), rootId: crashed.rootId, acceptUnknownUsage: true })
  assert.equal(accepted.status, 'needs_human')
  state = await loadOrchestration(accepted.directory)
  const interrupted = state.state.attemptOrder.map(id => state.state.attempts[id]!).find(item => item.status === 'interrupted')
  assert.equal(interrupted?.unknownSideEffects, true)
  assert.ok(Object.values(state.state.human).some(item => item.request.kind === 'unknown_side_effects' && !item.response))
  assert.equal(calls.count, callsAtCrash, 'adoption must not call the provider again')
  const retried = await resumeOrchestrate({
    ...resumeOptions(baseDirectory, adapter), rootId: crashed.rootId, acceptUnknownUsage: true, retry: ['st-2'],
  })
  assert.equal(retried.status, 'completed', retried.error)
  state = await loadOrchestration(retried.directory)
  assert.equal(state.state.attempts[interrupted!.attemptId]?.outcome, 'interrupted')
  assert.equal(state.state.finished?.status, 'completed')
  assert.equal(state.state.verifications[0]?.exitCode, 0)
})

test('resume refuses an incomplete orchestration log tail without touching it', async t => {
  const { repo, baseDirectory } = await repository(t)
  const calls = { count: 0 }
  const crashed = await orchestrate(runOptions(repo, baseDirectory, scripted(calls), single))
  assert.equal(crashed.status, 'completed')
  const log = path.join(crashed.directory, 'orchestration.jsonl')
  const before = await fs.readFile(log, 'utf8')
  await fs.appendFile(log, '{"v":1,"rootId":')
  await assert.rejects(
    resumeOrchestrate({ ...resumeOptions(baseDirectory, scripted(calls)), rootId: crashed.rootId }),
    /incomplete orchestration JSONL tail/,
  )
  assert.equal((await fs.readFile(log, 'utf8')).startsWith(before), true)
})
