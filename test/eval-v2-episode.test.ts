import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { emptyCounters } from '../src/core/budget.js'
import type { BudgetPolicy, RunState, StopReason } from '../src/core/budget.js'
import { runV2Stages, snapshotWorkspace } from '../scripts/eval-v2-episode.js'
import { runFixtureTask } from '../scripts/eval-fixture.js'

const policy: BudgetPolicy = { maxModelRequests: 3, maxToolCalls: 4, maxTotalTokens: 100, maxActiveDurationMs: 10_000 }
const state = (runId: string, status: StopReason, requests: number, tools: number, tokens: number): RunState => ({
  sessionId: 's', taskId: runId, runId, model: 'test/model', policy,
  status, usage: [], removedTaskIds: [], counters: { ...emptyCounters(), modelRequests: requests, toolCalls: tools, totalTokens: tokens },
})

test('V2 episode shares the budget across stages and stops before an exhausted stage', async () => {
  const budgets: BudgetPolicy[] = []
  let latest: RunState | undefined
  const result = await runV2Stages({
    tasks: ['one', 'two', 'three'], policy,
    send: async (_task, budget) => {
      budgets.push(budget)
      latest = state(String(budgets.length), 'completed', budgets.length === 1 ? 2 : 1, 1, budgets.length === 1 ? 60 : 30)
    },
    latestRun: () => latest,
    snapshot: async index => ({ path: `snapshot-${index}`, hash: `hash-${index}` }),
    now: () => 0,
  })
  assert.equal(result.status, 'max_steps')
  assert.equal(budgets.length, 2)
  assert.deepEqual(budgets.map(budget => [budget.maxModelRequests, budget.maxToolCalls, budget.maxTotalTokens]), [[3, 4, 100], [1, 3, 40]])
  assert.deepEqual(result.stages.map(stage => [stage.cumulative.modelRequests, stage.cumulative.totalTokens]), [[2, 60], [3, 90]])
})

test('V2 episode preserves the first failed stage and never dispatches later work', async () => {
  let calls = 0
  let latest: RunState | undefined
  const result = await runV2Stages({
    tasks: ['one', 'two', 'three'], policy,
    send: async () => { calls += 1; latest = state(String(calls), calls === 2 ? 'output_limit' : 'completed', 1, 0, 10) },
    latestRun: () => latest,
    snapshot: async index => ({ path: `snapshot-${index}`, hash: 'hash' }),
  })
  assert.equal(calls, 2)
  assert.equal(result.status, 'output_limit')
  assert.deepEqual(result.stages.map(stage => stage.status), ['completed', 'output_limit'])
})

test('V2 refuses a missing snapshot instead of returning an accepted episode', async () => {
  let latest: RunState | undefined
  await assert.rejects(runV2Stages({
    tasks: ['one'], policy,
    send: async () => { latest = state('1', 'completed', 1, 0, 10) },
    latestRun: () => latest,
    snapshot: async () => { throw new Error('disk unavailable') },
  }), /disk unavailable/)
})

test('V2 watchdog cancels the active stage and prevents the next stage', async () => {
  let calls = 0
  const result = await runV2Stages({
    tasks: ['one', 'two'], policy: { ...policy, maxActiveDurationMs: 10 },
    send: async (_task, _budget, signal) => {
      calls += 1
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    },
    latestRun: () => state('1', 'cancelled', 1, 0, 10),
    snapshot: async () => ({ path: 'snapshot-1', hash: 'hash' }),
  })
  assert.equal(result.status, 'timeout')
  assert.equal(calls, 1)
})

test('V2 fixture path saves real stage snapshots and keeps the old fixture path available', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-v2-episode-'))
  try {
    const outcome = await runFixtureTask('ledger', () => ({
      provider: 'test', model: 'complete', capabilities: { complete: { contextWindowTokens: 1_000_000 } },
      chat: async () => ({ content: 'done' }),
    }), { ...policy, maxModelRequests: 1, maxTotalTokens: 2_000_000 }, undefined, undefined, undefined, path.join(directory, 'snapshots'))
    assert.equal(outcome.status, 'max_steps')
    assert.equal(outcome.episode?.stages.length, 1)
    const snapshot = outcome.episode?.stages[0]
    assert.ok(snapshot)
    assert.equal(snapshot.contractHash.length, 64)
    assert.equal(snapshot.snapshotHash.length, 64)
    assert.ok((await fs.stat(path.join(snapshot.snapshotPath, 'src', 'parse.mjs'))).isFile())
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('snapshot rejects symlinks and an in-workspace destination', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-v2-snapshot-'))
  try {
    const workspace = path.join(directory, 'candidate')
    await fs.mkdir(workspace)
    await assert.rejects(snapshotWorkspace(workspace, path.join(workspace, 'snapshots'), 1), /outside candidate workspace/)
    await fs.writeFile(path.join(workspace, 'a.txt'), 'a')
    const first = await snapshotWorkspace(workspace, path.join(directory, 'snapshots'), 1)
    await assert.rejects(snapshotWorkspace(workspace, path.join(directory, 'snapshots'), 1))
    assert.equal(first.hash.length, 64)
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})
