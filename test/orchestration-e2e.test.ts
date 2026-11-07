import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ChatResponse, ToolCall } from '../src/core/contracts.js'
import { branchExists, commitAll, findCommitByTrailer, git, headCommit, stageAll, statusPorcelain } from '../src/orchestration/git.js'
import { orchestrate } from '../src/orchestration/orchestrator.js'
import { loadOrchestration } from '../src/orchestration/inspect.js'
import { integrationBranchName } from '../src/orchestration/worktrees.js'
import type { PlanInput } from '../src/orchestration/contracts.js'
import { parseOrchestrateArgs } from '../src/app/orchestrate-cli.js'

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

test('a dirty working tree is refused before any orchestration state is created', async t => {
  const { repo, baseDirectory } = await repository(t)
  await fs.writeFile(path.join(repo, 'dirty.txt'), 'x')
  await assert.rejects(orchestrate(options(repo, baseDirectory, scripted([]))), /uncommitted change/)
  await assert.rejects(fs.stat(baseDirectory))
  await fs.rm(path.join(repo, 'dirty.txt'))
})

test('orchestrate CLI parser accepts the M1 run surface and rejects ambiguous input', () => {
  const run = parseOrchestrateArgs(['run', '--task', 'do it', '--plan', 'p.json', '--verify', 'node check.mjs', '--max-workers', '3'])
  assert.equal(run.kind, 'run')
  if (run.kind === 'run') { assert.equal(run.task, 'do it'); assert.equal(run.maxWorkers, 3); assert.deepEqual(run.verifyCommands, ['node check.mjs']) }
  assert.throws(() => parseOrchestrateArgs(['run', '--task', 'do it']), /--plan is required/)
  assert.throws(() => parseOrchestrateArgs(['run', '--task', 'a', '--task-file', 'b', '--plan', 'p']), /exactly one/)
  assert.throws(() => parseOrchestrateArgs(['run', '--task', 'a', '--plan', 'p', '--max-workers', '9']), /1\.\.4/)
  assert.throws(() => parseOrchestrateArgs(['unknown']), /usage:/)
})
