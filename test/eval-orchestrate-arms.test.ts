import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { CommandOptions, CommandResult } from '../src/core/command-runner.js'
import { runCommand } from '../src/core/command-runner.js'
import type { ChatRequest, ChatResponse } from '../src/core/contracts.js'
import { ModelNotDispatchedError } from '../src/core/model-dispatch.js'
import {
  createBatchAmountGuard, perWorkspaceRunner, rehearsalAdapter, rehearsalTasks, runBatch, workspaceRootOf,
} from '../scripts/eval-orchestrate-arms.js'
import { batchModel, orchestrationPriceSnapshot } from '../scripts/eval-orchestrate-batch.js'
import { assembleRunMatrix } from '../scripts/eval-orchestrate.js'
import { orchestrationFixtureIds } from '../scripts/orchestration-fixtures.js'

const price = orchestrationPriceSnapshot
const providerUsage = { inputTokens: 1_000, outputTokens: 100, totalTokens: 1_100, source: 'provider' as const, uncertain: false, cacheReadTokens: 0 }
const request = { messages: [], maxOutputTokens: 16_384 } as unknown as ChatRequest
// 满上下文输入 + 满输出的单请求预留：0.30 + 16,384 × 1.20 / 1M。
const reserve = 0.3 + 16_384 * 1.2 / 1_000_000

async function temp(t: { after: (fn: () => Promise<void>) => void }, prefix: string) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  return directory
}

test('the amount guard counts in-flight reservations so concurrent requests cannot jointly exceed the cap', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let dispatched = 0
  const guard = createBatchAmountGuard(async () => { dispatched++; await gate; return { usage: providerUsage, content: 'ok' } }, price, reserve * 1.5)
  const first = guard.chat(request)
  await assert.rejects(guard.chat(request), (error: unknown) => error instanceof ModelNotDispatchedError && error.reason === 'amount_limit')
  assert.equal(dispatched, 1)
  assert.equal(guard.stopped, 'amount_limit')
  release()
  await first
  assert.equal(guard.pendingUsd, 0)
  assert.ok(guard.spentUsd > 0 && guard.spentUsd < 0.01)
  assert.equal(guard.calls, 1)
})

test('the amount guard refuses every call after a response without provider usage', async () => {
  let dispatched = 0
  const guard = createBatchAmountGuard(async (): Promise<ChatResponse> => { dispatched++; return { content: 'no usage' } }, price, 10)
  await guard.chat(request)
  assert.equal(guard.usageUnknown, true)
  await assert.rejects(guard.chat(request), (error: unknown) => error instanceof ModelNotDispatchedError && error.reason === 'usage_unknown')
  assert.equal(dispatched, 1)
  assert.throws(() => createBatchAmountGuard(async () => ({}), price, 0), /positive maxUsd/)
  await assert.rejects(createBatchAmountGuard(async () => ({}), price, 10).chat({ messages: [] } as unknown as ChatRequest), /output ceiling/)
})

test('commands are routed to a runner bound to the git workspace that contains their cwd', async t => {
  const root = await temp(t, 'orch-runner-')
  const repo = path.join(root, 'repo'), worktree = path.join(root, 'wt')
  await fs.mkdir(path.join(repo, '.git'), { recursive: true })
  await fs.mkdir(path.join(repo, 'packages', 'a'), { recursive: true })
  await fs.mkdir(worktree)
  await fs.writeFile(path.join(worktree, '.git'), 'gitdir: elsewhere\n')
  assert.equal(workspaceRootOf(path.join(repo, 'packages', 'a')), path.resolve(repo))
  assert.equal(workspaceRootOf(worktree), path.resolve(worktree))
  const created: string[] = []
  const runner = perWorkspaceRunner(workspace => { created.push(workspace); return async (options: CommandOptions) => ({ workspace, cwd: options.cwd }) as unknown as CommandResult })
  await runner({ cwd: path.join(repo, 'packages', 'a'), command: 'x' } as CommandOptions)
  await runner({ cwd: repo, command: 'y' } as CommandOptions)
  await runner({ cwd: worktree, command: 'z' } as CommandOptions)
  assert.deepEqual(created, [path.resolve(repo), path.resolve(worktree)])
  assert.throws(() => workspaceRootOf(path.parse(root).root), /no git workspace/)
})

test('a scripted rehearsal runs every arm end to end and the hidden verifier passes', async t => {
  const root = await temp(t, 'orch-rehearse-')
  const tasks = await rehearsalTasks(orchestrationFixtureIds, path.join(root, 'scratch'))
  const adapter = rehearsalAdapter(tasks)
  const all = assembleRunMatrix({ model: batchModel })
  const specs = [...all.filter(spec => spec.taskId === 'parallel-composite' && spec.repeat === 1), all.find(spec => spec.runId === 'single-repair:R:1')!]
  const routed: string[] = []
  const outcome = await runBatch({
    specs, evidenceRoot: path.join(root, 'evidence'), adapter, price, maxUsd: 30,
    // 宿主 runner 代替隔离 runner（CI 无 WSL）；仍经按工作区分发，证明每个 worktree 拿到自己的 runner。
    commandRunnerFactory: workspace => { routed.push(workspace); return options => runCommand(options) },
  })
  assert.equal(outcome.stopReason, 'completed')
  assert.equal(outcome.runs.length, 5)
  for (const run of outcome.runs) {
    assert.equal(run.hidden.passed, true, `${run.runId}: ${JSON.stringify(run.hidden.results)} ${run.error ?? ''}`)
    assert.ok(run.meter.bashCalls >= 1, `${run.runId} ran no smoke check`)
    assert.equal(run.meter.unknownUsageResponses, 0)
  }
  const r = outcome.runs.find(run => run.arm === 'R')!
  assert.equal(r.status, 'completed')
  assert.deepEqual(r.orchestration?.attempts.map(item => item.subtaskId).sort(), ['st-1', 'st-2', 'st-3'])
  assert.equal(r.orchestration?.conflicts, 0)
  // R 的三个 worker 各在自己的 worktree 中执行 Bash。
  assert.ok(new Set(routed).size >= 3)
  assert.equal(outcome.calls, adapter.requests())
  const saved = JSON.parse(await fs.readFile(path.join(root, 'evidence', 'runs', '01-parallel-composite_S_1', 'run.json'), 'utf8'))
  assert.equal(saved.runId, 'parallel-composite:S:1')
})

test('the batch stops at the first run that leaves usage unknown', async t => {
  const root = await temp(t, 'orch-unknown-')
  const tasks = await rehearsalTasks(['single-repair'], path.join(root, 'scratch'))
  const scripted = rehearsalAdapter(tasks)
  const adapter = { ...scripted, chat: async (input: ChatRequest) => { const response = await scripted.chat(input); return { ...response, usage: undefined } } }
  const specs = assembleRunMatrix({ model: batchModel, tasks: ['single-repair'] })
  const outcome = await runBatch({ specs, evidenceRoot: path.join(root, 'evidence'), adapter, price, maxUsd: 30, commandRunnerFactory: () => options => runCommand(options) })
  assert.equal(outcome.stopReason, 'usage_unknown')
  assert.equal(outcome.runs.length, 1)
})

test('the batch stops before any provider call when the cap cannot reserve one request', async t => {
  const root = await temp(t, 'orch-cap-')
  const tasks = await rehearsalTasks(['single-repair'], path.join(root, 'scratch'))
  const adapter = rehearsalAdapter(tasks)
  const specs = assembleRunMatrix({ model: batchModel, tasks: ['single-repair'] })
  const outcome = await runBatch({ specs, evidenceRoot: path.join(root, 'evidence'), adapter, price, maxUsd: reserve / 2, commandRunnerFactory: () => options => runCommand(options) })
  assert.equal(outcome.stopReason, 'amount_cap_before_request')
  assert.equal(adapter.requests(), 0)
  assert.equal(outcome.runs.length, 1)
  assert.equal(outcome.runs[0]!.hidden.passed, false)
})
