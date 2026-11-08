import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { TaskGroupBudgetCoordinator } from '../src/core/task-group-budget.js'
import type { TaskGroupPolicy } from '../src/core/task-group-budget.js'
import { ModelNotDispatchedError } from '../src/core/model-dispatch.js'
import { OrchestrationStore, newRootId } from '../src/orchestration/store.js'
import { OrchestrationGroupJournal } from '../src/orchestration/group-journal.js'
import { foldOrchestration, orchestrationTotals } from '../src/orchestration/state.js'
import { SESSION, rootStart } from './orchestration-fixtures.js'

const POLICY: Partial<TaskGroupPolicy> = { maxModelRequests: 4, maxToolCalls: 2, maxTotalTokens: 10_000, rootRequestFloor: 0, rootTokenFloor: 0, maxWallDurationMs: 60_000 }
const usage = (tokens: number) => ({ inputTokens: tokens, outputTokens: 0, totalTokens: tokens, source: 'provider' as const, uncertain: false })
const scope = (requestId: string, reserve = 1000) => ({ sessionId: SESSION, taskId: 'task', runId: 'run', requestId, agentId: 'worker', root: false, purpose: 'main' as const, reserve })

async function temporary(t: import('node:test').TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-ledger-')), rootId = newRootId()
  let active: OrchestrationStore | undefined
  t.after(async () => { await active?.close().catch(() => {}); await fs.rm(directory, { recursive: true, force: true }) })
  const open = async () => (active = await OrchestrationStore.open(directory, rootId))
  const store = await open()
  await store.append('root/start', rootStart())
  return { directory, rootId, store, open }
}

test('root budget reservations are persisted in the orchestration log and fold into totals', async t => {
  const { store } = await temporary(t)
  const group = await TaskGroupBudgetCoordinator.openJournal(new OrchestrationGroupJournal(store), POLICY, () => 1000)
  await group.reserve(scope('req-1'))
  await group.dispatched('req-1')
  await group.settle('req-1', usage(700))
  const events = await store.read()
  assert.deepEqual(events.map(event => event.type), ['root/start', 'group/start', 'group/budget-reserved', 'group/model-dispatched', 'group/budget-settled'])
  const state = foldOrchestration(events)
  assert.equal(state.ledger.reservations['req-1']?.status, 'settled')
  assert.deepEqual(orchestrationTotals(state), { requests: 1, providerTokens: 700, estimatedTokens: 0, unknownChargedTokens: 0, outstandingTokens: 0, cacheReadTokens: 0 })
  assert.equal(group.snapshot().settledTokens, 700)
})

test('reopening the ledger releases undurable reservations and charges dispatched ones as unknown', async t => {
  const { store, open } = await temporary(t)
  const group = await TaskGroupBudgetCoordinator.openJournal(new OrchestrationGroupJournal(store), POLICY, () => 1000)
  await group.reserve(scope('req-reserved'))
  await group.reserve(scope('req-dispatched'))
  await group.dispatched('req-dispatched')
  await store.close()
  const reopened = await open()
  const resumed = await TaskGroupBudgetCoordinator.openJournal(new OrchestrationGroupJournal(reopened), POLICY, () => 1000)
  const events = await reopened.read()
  assert.ok(events.some(event => event.type === 'group/reservation-released' && event.data.requestId === 'req-reserved'))
  assert.ok(events.some(event => event.type === 'group/usage-unknown' && event.data.requestId === 'req-dispatched'))
  assert.equal(foldOrchestration(events).ledger.reservations['req-dispatched']?.status, 'unknown')
  await assert.rejects(resumed.reserve(scope('req-next')), (error: unknown) => error instanceof ModelNotDispatchedError && error.reason === 'usage_unknown')
})

test('concurrent reservations cannot overspend the root token budget', async t => {
  const { store } = await temporary(t)
  const group = await TaskGroupBudgetCoordinator.openJournal(new OrchestrationGroupJournal(store), { ...POLICY, maxTotalTokens: 1500 }, () => 1000)
  const results = await Promise.allSettled([group.reserve(scope('req-a')), group.reserve(scope('req-b'))])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  const rejected = results.find(result => result.status === 'rejected')
  assert.equal(rejected?.status, 'rejected')
  if (rejected?.status === 'rejected') assert.ok(rejected.reason instanceof ModelNotDispatchedError && rejected.reason.reason === 'other_limit')
  assert.equal(Object.keys(foldOrchestration(await store.read()).ledger.reservations).length, 1)
})

test('the root wall deadline is enforced through an injected clock', async t => {
  const { store } = await temporary(t)
  let now = 1000
  const group = await TaskGroupBudgetCoordinator.openJournal(new OrchestrationGroupJournal(store), { ...POLICY, maxWallDurationMs: 5000 }, () => now)
  now = 6000
  await assert.rejects(group.reserve(scope('req-late')), /wall deadline/)
  assert.equal(group.stopReason, 'timeout')
})
