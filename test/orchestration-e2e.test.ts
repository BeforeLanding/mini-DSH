import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ChatRequest, ChatResponse, ToolCall } from '../src/core/contracts.js'
import { branchExists, commitAll, findCommitByTrailer, git, headCommit, stageAll, statusPorcelain } from '../src/orchestration/git.js'
import { orchestrate } from '../src/orchestration/orchestrator.js'
import { loadOrchestration } from '../src/orchestration/inspect.js'
import { integrationBranchName } from '../src/orchestration/worktrees.js'
import type { PlanInput } from '../src/orchestration/contracts.js'
import { parseOrchestrateArgs } from '../src/app/orchestrate-cli.js'
import { inspectSession } from '../src/core/session-inspect.js'

const usage = { inputTokens: 100, outputTokens: 10, totalTokens: 110, source: 'provider' as const, uncertain: false }
const doneReport = '```json\n{"status":"done","summary":"wrote the file","uncertainties":[],"sources":[{"path":"src/a.txt"}]}\n```'
function scripted(steps: ToolCall[], final = doneReport) {
  let index = 0
  return {
    provider: 'scripted', model: 'test', capabilities: { test: { contextWindowTokens: 100_000 } },
    chat: async (): Promise<ChatResponse> => index < steps.length ? { usage, toolCalls: [steps[index++]!] } : { usage, content: final, complete: true, finishReason: 'stop' },
  }
}
let nextCall = 0
const write = (target: string, content: string): ToolCall => ({ id: `call-${++nextCall}`, name: 'write_file', arguments: { path: target, content } })
async function repository(t: import('node:test').TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-e2e-'))
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }) })
  const repo = path.join(root, 'repo')
  await fs.mkdir(repo)
  await git(repo, ['init', '--quiet'])
  await git(repo, ['config', 'core.autocrlf', 'false'])
  await fs.writeFile(path.join(repo, 'check.mjs'), `import fs from 'node:fs'\nconst text = fs.readFileSync(new URL('./src/a.txt', import.meta.url), 'utf8')\nif (text !== 'hello\\n') { console.error('FAIL'); process.exit(1) }\nconsole.log('PASS')\n`)
  await fs.writeFile(path.join(repo, 'base.txt'), 'base\n')
  await stageAll(repo)
  const baseCommit = await commitAll(repo, 'initial')
  return { root, repo, baseCommit, baseDirectory: path.join(root, 'orch') }
}
const plan: PlanInput = {
  version: 1, rationale: 'one independent file',
  subtasks: [{ id: 'st-1', title: 'write a', objective: 'create src/a.txt containing hello', writeSet: ['src/a.txt'], acceptance: { commands: ['node check.mjs'] } }],
}
function options(repo: string, baseDirectory: string, adapter: ReturnType<typeof scripted>, extra: { rootBudget?: { maxModelRequests?: number }; approval?: { approve: () => Promise<boolean> } } = {}) {
  return {
    repository: repo, goal: 'create src/a.txt', plan, baseDirectory, adapter, model: 'scripted/test',
    approval: { writes: 'auto' as const, bash: 'ask' as const, approve: extra.approval?.approve ?? (async () => true) },
    maxWorkers: 1, ...(extra.rootBudget ? { rootBudget: extra.rootBudget } : {}),
  }
}

test('single-attempt orchestration commits in a worktree, integrates, verifies and finishes', async t => {
  const { repo, baseCommit, baseDirectory } = await repository(t)
  const result = await orchestrate(options(repo, baseDirectory, scripted([write('src/a.txt', 'hello\n')])))
  assert.equal(result.status, 'completed', result.error)
  const report = await loadOrchestration(result.directory)
  assert.equal(report.state.status, 'completed')
  assert.equal(report.state.verifications.length, 1)
  assert.equal(report.state.verifications[0]?.exitCode, 0)
  const attemptId = report.state.attemptOrder[0]!, attempt = report.state.attempts[attemptId]!
  assert.equal(attempt.outcome, 'succeeded')
  assert.deepEqual(attempt.changedFiles, ['src/a.txt'])
  assert.equal(result.integrationBranch, integrationBranchName(result.rootId))
  assert.equal(await branchExists(repo, result.integrationBranch!), true)
  assert.equal(await findCommitByTrailer(repo, attempt.branch!, attemptId), attempt.commit)
  assert.equal(await fs.readFile(path.join(result.directory, 'worktrees', 'integration', 'src', 'a.txt'), 'utf8'), 'hello\n')
  assert.equal(await headCommit(repo), baseCommit)
  assert.deepEqual(await statusPorcelain(repo), [])
  await assert.rejects(fs.stat(path.join(repo, 'src', 'a.txt')))
  assert.ok(result.reportRef)
  const artifact = path.join(result.directory, 'artifacts', `sha256-${result.reportRef!.slice(7)}.json`)
  assert.equal(JSON.parse(await fs.readFile(artifact, 'utf8')).status, 'completed')
  // worker 会话仍是普通会话日志：现有只读 inspect 必须能完整读取。
  const inspection = await inspectSession(path.join(result.directory, 'sessions', attemptId, attempt.sessionId!, 'events.jsonl'))
  assert.equal(inspection.integrity.complete, true)
  assert.equal(inspection.session.id, attempt.sessionId)
})

test('a worker that changes nothing is recorded as no_changes and is not integrated', async t => {
  const { repo, baseDirectory } = await repository(t)
  const result = await orchestrate(options(repo, baseDirectory, scripted([])))
  assert.equal(result.status, 'failed')
  const report = await loadOrchestration(result.directory)
  const attempt = report.state.attempts[report.state.attemptOrder[0]!]!
  assert.equal(attempt.outcome, 'no_changes')
  assert.equal(report.state.integration, undefined)
  assert.equal(await branchExists(repo, integrationBranchName(result.rootId)), false)
})

test('writes outside the declared write set are refused before integration', async t => {
  const { repo, baseDirectory } = await repository(t)
  const result = await orchestrate(options(repo, baseDirectory, scripted([write('outside.txt', 'nope\n')])))
  assert.equal(result.status, 'failed')
  const report = await loadOrchestration(result.directory)
  const attempt = report.state.attempts[report.state.attemptOrder[0]!]!
  assert.equal(attempt.outcome, 'scope_violation')
  assert.deepEqual(attempt.scopeViolations, ['outside.txt'])
  assert.equal(report.state.integration, undefined)
  assert.equal(await fs.readFile(path.join(result.directory, 'worktrees', attempt.attemptId, 'outside.txt'), 'utf8'), 'nope\n')
})

test('the root budget stops the worker before a second provider request', async t => {
  const { repo, baseDirectory } = await repository(t)
  const result = await orchestrate(options(repo, baseDirectory, scripted([write('src/a.txt', 'hello\n'), write('src/a.txt', 'again\n')]), { rootBudget: { maxModelRequests: 1 } }))
  assert.equal(result.status, 'failed')
  const report = await loadOrchestration(result.directory)
  const attempt = report.state.attempts[report.state.attemptOrder[0]!]!
  assert.equal(attempt.outcome, 'budget_stopped')
  assert.equal(attempt.runStatus, 'max_steps')
  assert.equal(report.totals.requests, 1)
  assert.equal(report.state.integration, undefined)
})

const compositePlan: PlanInput = {
  version: 1, rationale: 'three independent files; the index depends on both parsers',
  subtasks: [
    { id: 'st-1', title: 'write a', objective: 'create src/a.txt containing a', writeSet: ['src/a.txt'], acceptance: { commands: ['node check.mjs'] } },
    { id: 'st-2', title: 'write b', objective: 'create src/b.txt containing b', writeSet: ['src/b.txt'], acceptance: { commands: ['node check.mjs'] } },
    { id: 'st-3', title: 'write index', objective: 'create src/index.txt containing a+b', writeSet: ['src/index.txt'], dependsOn: ['st-1', 'st-2'], acceptance: { commands: ['node check.mjs'] } },
  ],
}
async function compositeRepository(t: import('node:test').TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-parallel-'))
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }) })
  const repo = path.join(root, 'repo')
  await fs.mkdir(repo)
  await git(repo, ['init', '--quiet'])
  await git(repo, ['config', 'core.autocrlf', 'false'])
  await fs.writeFile(path.join(repo, 'check.mjs'), `import fs from 'node:fs'\nconst read = relative => fs.readFileSync(new URL(relative, import.meta.url), 'utf8')\nif (read('./src/a.txt') !== 'a\\n') { console.error('a'); process.exit(1) }\nif (read('./src/b.txt') !== 'b\\n') { console.error('b'); process.exit(1) }\nif (read('./src/index.txt') !== 'a+b\\n') { console.error('index'); process.exit(1) }\nconsole.log('PASS')\n`)
  await fs.writeFile(path.join(repo, 'base.txt'), 'base\n')
  await stageAll(repo)
  const baseCommit = await commitAll(repo, 'initial')
  return { root, repo, baseCommit, baseDirectory: path.join(root, 'orch') }
}
const reportFor = (target: string) => `\`\`\`json\n${JSON.stringify({ status: 'done', summary: `wrote ${target}`, uncertainties: [], sources: [{ path: target }] })}\n\`\`\``
function compositeAdapter(coincide = true) {
  const writes: Record<string, [string, string]> = {
    'st-1': ['src/a.txt', 'a\n'], 'st-2': ['src/b.txt', 'b\n'], 'st-3': ['src/index.txt', 'a+b\n'],
  }
  let arrivals = 0, release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const adapter = {
    provider: 'scripted', model: 'test', capabilities: { test: { contextWindowTokens: 100_000 } },
    chat: async (request: ChatRequest): Promise<ChatResponse> => {
      const messages = request.messages ?? []
      const text = messages.map(message => typeof message.content === 'string' ? message.content : '').join('\n')
      const id = text.includes('Subtask st-3') ? 'st-3' : text.includes('Subtask st-2') ? 'st-2' : 'st-1'
      if (!messages.some(message => message.role === 'tool')) {
        // 两个第一波 worker 都必须先到达模型调用，保证 started/finished 区间确实重叠。
        if (coincide && (id === 'st-1' || id === 'st-2')) {
          arrivals++
          if (arrivals === 2) release()
          await Promise.race([barrier, new Promise(resolve => setTimeout(resolve, 2000))])
        }
        const [target, content] = writes[id]!
        return { usage, toolCalls: [write(target, content)], complete: true }
      }
      return { usage, content: reportFor(writes[id]![0]), complete: true, finishReason: 'stop' }
    },
  }
  return adapter
}

test('two workers run in the same wave and a dependent third runs after integration', async t => {
  const { repo, baseCommit, baseDirectory } = await compositeRepository(t)
  const result = await orchestrate({
    repository: repo, goal: 'create three files', plan: compositePlan, baseDirectory, adapter: compositeAdapter(), model: 'scripted/test',
    maxWorkers: 2, approval: { writes: 'auto', bash: 'ask', approve: async () => true },
  })
  assert.equal(result.status, 'completed', result.error)
  const report = await loadOrchestration(result.directory)
  assert.deepEqual(report.state.decision?.waves, [['st-1', 'st-2'], ['st-3']])
  assert.equal(report.state.integrations.length, 2)
  const appliedSubtasks = report.state.integrations.flatMap(integration => integration.applied.map(item => report.state.attempts[item.attemptId]!.subtaskId))
  assert.deepEqual(appliedSubtasks, ['st-1', 'st-2', 'st-3'])
  const waveOne = report.state.attemptOrder.map(id => report.state.attempts[id]!).filter(attempt => attempt.wave === 0)
  assert.equal(waveOne.length, 2)
  const started = (attemptId: string) => report.events.find(event => event.type === 'attempt/started' && event.data.attemptId === attemptId)!.at
  const finished = (attemptId: string) => report.events.find(event => event.type === 'attempt/finished' && event.data.attemptId === attemptId)!.at
  const [first, second] = waveOne
  assert.ok(Date.parse(started(first!.attemptId)) < Date.parse(finished(second!.attemptId)))
  assert.ok(Date.parse(started(second!.attemptId)) < Date.parse(finished(first!.attemptId)))
  const indexAttempt = report.state.attemptOrder.map(id => report.state.attempts[id]!).find(attempt => attempt.subtaskId === 'st-3')!
  assert.equal(indexAttempt.wave, 1)
  assert.equal(await fs.readFile(path.join(indexAttempt.worktree!, 'src', 'a.txt'), 'utf8'), 'a\n')
  assert.equal(report.state.verifications.length, 1)
  assert.equal(report.state.verifications[0]?.exitCode, 0)
  assert.equal(await headCommit(repo), baseCommit)
  assert.deepEqual(await statusPorcelain(repo), [])
})

test('single mode executes the same plan one worker at a time', async t => {
  const { repo, baseDirectory } = await compositeRepository(t)
  const result = await orchestrate({
    repository: repo, goal: 'create three files', plan: compositePlan, baseDirectory, adapter: compositeAdapter(false), model: 'scripted/test',
    mode: 'single', maxWorkers: 2, approval: { writes: 'auto', bash: 'ask', approve: async () => true },
  })
  assert.equal(result.status, 'completed', result.error)
  const report = await loadOrchestration(result.directory)
  assert.equal(report.state.decision?.mode, 'single')
  const waveOne = report.state.attemptOrder.map(id => report.state.attempts[id]!).filter(attempt => attempt.wave === 0)
  const finished = (attemptId: string) => report.events.find(event => event.type === 'attempt/finished' && event.data.attemptId === attemptId)!.at
  const started = (attemptId: string) => report.events.find(event => event.type === 'attempt/started' && event.data.attemptId === attemptId)!.at
  assert.ok(Date.parse(finished(waveOne[0]!.attemptId)) <= Date.parse(started(waveOne[1]!.attemptId)))
})

test('the read-only planner can replace a plan file and its session stays inspectable', async t => {
  const { repo, baseDirectory } = await repository(t)
  const planned = `\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``
  const adapter = {
    provider: 'scripted', model: 'test', capabilities: { test: { contextWindowTokens: 100_000 } },
    chat: async (request: ChatRequest): Promise<ChatResponse> => {
      const text = `${request.system ?? ''}\n${(request.messages ?? []).map(message => typeof message.content === 'string' ? message.content : '').join('\n')}`
      if (text.includes('read-only planner')) return { usage, content: planned, complete: true, finishReason: 'stop' }
      const messages = request.messages ?? []
      return messages.some(message => message.role === 'tool')
        ? { usage, content: doneReport, complete: true, finishReason: 'stop' }
        : { usage, toolCalls: [write('src/a.txt', 'hello\n')], complete: true }
    },
  }
  const result = await orchestrate({
    repository: repo, goal: 'create src/a.txt', baseDirectory, adapter, model: 'scripted/test',
    maxWorkers: 1, approval: { writes: 'auto', bash: 'ask', approve: async () => true },
  })
  assert.equal(result.status, 'completed', result.error)
  const report = await loadOrchestration(result.directory)
  assert.equal(report.state.plan?.source, 'model')
  const plannerSessionId = report.state.plan?.plannerSessionId
  assert.ok(plannerSessionId)
  const inspection = await inspectSession(path.join(result.directory, 'sessions', 'planner', plannerSessionId!, 'events.jsonl'))
  assert.equal(inspection.integrity.complete, true)
  assert.equal(inspection.session.id, plannerSessionId)
})

test('a dirty working tree is refused before any orchestration state is created', async t => {
  const { repo, baseDirectory } = await repository(t)
  await fs.writeFile(path.join(repo, 'dirty.txt'), 'x')
  await assert.rejects(orchestrate(options(repo, baseDirectory, scripted([]))), /uncommitted change/)
  await assert.rejects(fs.stat(baseDirectory))
  await fs.rm(path.join(repo, 'dirty.txt'))
})

test('orchestrate CLI parser accepts plan files or the read-only planner and rejects ambiguous input', () => {
  const run = parseOrchestrateArgs(['run', '--task', 'do it', '--plan', 'p.json', '--verify', 'node check.mjs', '--max-workers', '3'])
  assert.equal(run.kind, 'run')
  if (run.kind === 'run') { assert.equal(run.task, 'do it'); assert.equal(run.maxWorkers, 3); assert.deepEqual(run.verifyCommands, ['node check.mjs']) }
  const planner = parseOrchestrateArgs(['run', '--task', 'do it'])
  assert.equal(planner.kind, 'run')
  if (planner.kind === 'run') assert.equal(planner.planPath, '')
  assert.throws(() => parseOrchestrateArgs(['run', '--task', 'a', '--task-file', 'b', '--plan', 'p']), /exactly one/)
  assert.throws(() => parseOrchestrateArgs(['run', '--task', 'a', '--plan', 'p', '--max-workers', '9']), /1\.\.4/)
  assert.throws(() => parseOrchestrateArgs(['unknown']), /usage:/)
})
