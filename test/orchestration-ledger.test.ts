import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { TaskGroupBudgetCoordinator } from '../src/core/task-group-budget.js'
import type { TaskGroupPolicy } from '../src/core/task-group-budget.js'
import { ModelNotDispatchedError } from '../src/core/model-dispatch.js'
import { ProviderError } from '../src/core/model-error.js'
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

test('the in-flight limit bounds reserved and dispatched requests', async t => {
  const { store } = await temporary(t)
  const group = await TaskGroupBudgetCoordinator.openJournal(new OrchestrationGroupJournal(store), { ...POLICY, maxInFlightRequests: 1 }, () => 1000)
  await group.reserve(scope('req-a'))
  await assert.rejects(group.reserve(scope('req-b')), (error: unknown) => error instanceof ModelNotDispatchedError && error.reason === 'request_limit')
  await group.dispatched('req-a')
  await assert.rejects(group.reserve(scope('req-c')), /in-flight request limit/)
  await group.settle('req-a', usage(700))
  await group.reserve(scope('req-d'))
  assert.equal(group.snapshot().requests, 2)
})

test('cancel-induced unknown usage does not block, while crash unknown needs explicit acceptance', async t => {
  const { store } = await temporary(t)
  const group = await TaskGroupBudgetCoordinator.openJournal(new OrchestrationGroupJournal(store), POLICY, () => 1000)
  await group.reserve(scope('req-cancel')); await group.dispatched('req-cancel')
  await group.settle('req-cancel', undefined, 'cancel')
  assert.equal(group.snapshot().usageUnknown, true)
  assert.equal(group.snapshot().blockingUnknown, false)
  await group.reserve(scope('req-after-cancel'))
  await group.reserve(scope('req-crash')); await group.dispatched('req-crash')
  await group.settle('req-crash', undefined, 'crash')
  assert.equal(group.snapshot().blockingUnknown, true)
  await assert.rejects(group.reserve(scope('req-blocked')), /unknown provider usage/)
  group.acceptUnknownUsage()
  await group.reserve(scope('req-accepted')); await group.dispatched('req-accepted'); await group.settle('req-accepted', usage(100))
  const state = foldOrchestration(await store.read())
  assert.equal(state.ledger.reservations['req-cancel']?.cause, 'cancel')
  assert.equal(state.ledger.reservations['req-crash']?.cause, 'crash')
  assert.equal(state.ledger.reservations['req-crash']?.status, 'unknown')
})

test('a 429 releases its reservation and a shared cooldown delays the next dispatch', async t => {
  const { store } = await temporary(t)
  const waits: number[] = []
  let now = 1000
  const group = await TaskGroupBudgetCoordinator.openJournal(new OrchestrationGroupJournal(store), { ...POLICY, maxModelRequests: 8 }, () => now, async ms => { waits.push(ms); now += ms })
  const request = (requestId: string) => ({
    system: 'test', maxOutputTokens: 32,
    dispatchScope: { sessionId: SESSION, taskId: 'task', runId: 'run', requestId },
  })
  await assert.rejects(
    group.dispatch(request('req-429'), { agentId: 'worker', root: false }, async () => { throw new ProviderError('rate_limit', 429, true, undefined, 500) }),
    /rate limit/,
  )
  assert.equal(group.snapshot().cooldownUntil, 3000)
  assert.equal(group.snapshot().requests, 0, 'the rejected reservation is released, not charged')
  const response = await group.dispatch(request('req-retry'), { agentId: 'worker', root: false }, async () => ({ usage: usage(100), content: 'ok' }))
  assert.equal(response.content, 'ok')
  assert.deepEqual(waits, [2000])
  assert.equal(group.snapshot().settledTokens, 100)
})

test('the root wall deadline is enforced through an injected clock', async t => {
  const { store } = await temporary(t)
  let now = 1000
  const group = await TaskGroupBudgetCoordinator.openJournal(new OrchestrationGroupJournal(store), { ...POLICY, maxWallDurationMs: 5000 }, () => now)
  now = 6000
  await assert.rejects(group.reserve(scope('req-late')), /wall deadline/)
  assert.equal(group.stopReason, 'timeout')
})
