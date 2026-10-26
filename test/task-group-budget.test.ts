import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { TaskGroupBudgetCoordinator, groupPolicy } from '../src/core/task-group-budget.js'
import type { GroupReservation } from '../src/core/task-group-budget.js'
import { SessionRuntime } from '../src/core/session-runtime.js'
import { JsonlStore, parseLog } from '../src/core/event-store.js'
import { createHarness } from '../src/app/create-harness.js'
import { ModelNotDispatchedError } from '../src/core/model-dispatch.js'
import { ProviderError } from '../src/core/model-error.js'
import { memoryHash } from '../src/core/memory-contracts.js'
import type { Usage } from '../src/core/budget.js'

const usage = (tokens: number): Usage => ({ inputTokens: tokens, outputTokens: 0, totalTokens: tokens, source: 'provider', uncertain: false })
async function setup(t: import('node:test').TestContext, policy = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'group-budget-')), sessions = new SessionRuntime(), session = sessions.create({ workspace: directory })
  const store = await JsonlStore.open(directory, session.id); sessions.attachStore(session.id, store)
  const state = sessions.beginRun(session.id, {}, 'scripted/test'); await sessions.flush(session.id)
  const group = await TaskGroupBudgetCoordinator.open(sessions, session.id, state.taskId, { maxModelRequests: 4, maxToolCalls: 2, maxTotalTokens: 10_000, rootRequestFloor: 0, rootTokenFloor: 0, ...policy })
  t.after(async () => { await sessions.close(); await fs.rm(directory, { recursive: true, force: true }) })
  const reservation = (id: string = randomUUID(), reserve = 1000, root = false): GroupReservation => ({ sessionId: root ? session.id : randomUUID(), taskId: root ? state.taskId : randomUUID(), runId: root ? state.runId : randomUUID(), agentId: root ? session.id : 'worker', requestId: id, root, reserve, purpose: 'main' })
  return { directory, sessions, session, state, group, reservation }
}

test('group atomically admits at most one competing reservation and preserves root floors', async t => {
  const h = await setup(t, { maxModelRequests: 3, rootRequestFloor: 2, rootTokenFloor: 8000 })
  const contenders = [h.reservation('first', 1500), h.reservation('second', 1500)]
  const outcomes = await Promise.allSettled(contenders.map(item => h.group.reserve(item)))
  assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1)
  await h.group.reserve(h.reservation('root', 7000, true))
  assert.equal(h.group.snapshot().outstandingTokens, 8500)
  await assert.rejects(h.group.reserve(h.reservation('too-many', 1)), /request limit/)
  assert.throws(() => groupPolicy({ rootTokenFloor: 3_000_000 }), /root floor/)
})

test('group settles once, accounts tools by batch identity, detects conflicts and retains overrun', async t => {
  const h = await setup(t)
  await h.group.reserve(h.reservation('one')); await h.group.dispatched('one'); await h.group.settle('one', usage(500))
  await h.group.settle('one', usage(500))
  await assert.rejects(h.group.settle('one', usage(600)), /conflicting duplicate/)
  assert.equal(h.group.snapshot().settledTokens, 500); assert.equal(h.group.snapshot().outstandingTokens, 0)
  const tool = { key: memoryHash('batch1'), agentId: h.session.id, sessionId: h.session.id, runId: h.state.runId, toolCallId: 'read' }
  await h.group.admitTool(tool); await assert.rejects(h.group.admitTool(tool), /already admitted/)
  await h.group.admitTool({ ...tool, key: memoryHash('batch2') })
  await assert.rejects(h.group.admitTool({ ...tool, key: memoryHash('batch3') }), /tool limit/)
  await h.group.reserve(h.reservation('overrun', 10)); await h.group.dispatched('overrun'); await h.group.settle('overrun', usage(11))
  assert.equal(h.group.snapshot().overrun, true)
  await assert.rejects(h.group.reserve(h.reservation('blocked')), /overrun/)
  parseLog((await h.sessions.get(h.session.id)).events.map(event => JSON.stringify(event) + '\n').join(''), h.session.id)
})

test('group crash recovery releases undispatched intent, blocks unknown dispatched usage and never refreshes deadline or allowance', async t => {
  const h = await setup(t)
  await h.group.reserve(h.reservation('reserved'))
  await h.group.reserve(h.reservation('dispatched')); await h.group.dispatched('dispatched')
  await h.sessions.close()
  const sessions = new SessionRuntime(), store = await JsonlStore.open(h.directory, h.session.id)
  try {
    await sessions.restore(store, h.directory)
    const recovered = await TaskGroupBudgetCoordinator.open(sessions, h.session.id, h.state.taskId, { maxTotalTokens: 99_000_000 })
    assert.equal(recovered.start.deadline, h.group.start.deadline)
    assert.equal(recovered.start.policy.maxTotalTokens, 10_000)
    assert.equal(recovered.snapshot().requests, 1); assert.equal(recovered.snapshot().usageUnknown, true)
    assert.equal(recovered.snapshot().outstandingTokens, 1000)
    await assert.rejects(recovered.reserve(h.reservation('no-replay')), /unknown provider usage/)
    const events = await store.read(); assert.equal(events.filter(event => event.type === 'group/model-dispatched').length, 1)
    const again = await TaskGroupBudgetCoordinator.open(sessions, h.session.id, h.state.taskId)
    assert.equal(again.snapshot().usageUnknown, true)
  } finally { await sessions.close() }
})

test('group dispatch handles known pre-dispatch refusal and missing provider usage conservatively', async t => {
  const h = await setup(t)
  const request = { system: 'test', maxOutputTokens: 32, dispatchScope: { sessionId: h.session.id, taskId: h.state.taskId, runId: h.state.runId, requestId: 'reject' } }
  await assert.rejects(h.group.dispatch(request, { agentId: h.session.id, root: true }, async () => { throw new ModelNotDispatchedError('not sent', 'request_limit') }), /not sent/)
  assert.equal(h.group.snapshot().requests, 0)
  await assert.rejects(h.group.dispatch({ ...request, dispatchScope: { ...request.dispatchScope, requestId: 'missing' } }, { agentId: h.session.id, root: true }, async () => ({ content: 'unconfirmed' })), /usage is unknown/)
  assert.equal(h.group.snapshot().usageUnknown, true)
})

test('shared Harness guards root main, summary, retry and tools without adding scope to provider requests', async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'group-harness-'))
  const h = await createHarness({ workspace, profile: 'coding', taskGroupPolicy: { maxModelRequests: 4, maxTotalTokens: 1_000_000, rootRequestFloor: 0, rootTokenFloor: 0 } })
  t.after(async () => { await h.dispose(); await fs.rm(workspace, { recursive: true, force: true }) })
  let calls = 0
  h.root.llm.register('scripted', { models: ['test'], chat: async request => { assert.equal(request.dispatchScope, undefined); calls++; return { content: 'done', usage: usage(100) } } })
  const session = h.root.sessions.create({ workspace }), agent = h.root.agents.create({ sessionId: session.id, model: 'scripted/test', loop: h.root.agentLoop })
  await agent.send('first task')
  const state = h.root.sessions.latestRun(session.id)!, group = await h.taskGroups!.get(session.id, state.taskId)
  assert.equal(group.snapshot().requests, 1); assert.equal(group.snapshot().settledTokens, 100)
  const run = h.root.sessions.beginRun(session.id, {}, 'scripted/test')
  await h.root.llm.chat({ purpose: 'summary', maxOutputTokens: 32, dispatchScope: { sessionId: session.id, taskId: run.taskId, runId: run.runId, requestId: 'summary' } }, 'scripted/test')
  assert.equal((await h.taskGroups!.get(session.id, run.taskId)).snapshot().requests, 1)
  h.root.sessions.finishRun(run, 'completed')
  // A retryable failure without confirmed usage must not dispatch a second provider request.
  h.root.llm.register('broken', { models: ['test'], chat: async () => { calls++; throw new ProviderError('transient', 503, true) } })
  const broken = h.root.agents.create({ sessionId: session.id, model: 'broken/test', loop: h.root.agentLoop })
  await assert.rejects(broken.send('retry unknown usage'))
  assert.equal(calls, 3)
  const failed = h.root.sessions.latestRun(session.id)!
  assert.equal((await h.taskGroups!.get(session.id, failed.taskId)).snapshot().usageUnknown, true)
})
