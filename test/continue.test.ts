import test from 'node:test'
import assert from 'node:assert/strict'
import { harness } from './harness.js'
import { assertToolProtocol } from '../src/core/context-runtime.js'
test('continue starts a fresh run in the same task without replaying user input or tools', async () => {
  let models = 0, tools = 0
  const h = harness(async ({ messages = [] }) => {
    models++
    if (models <= 2) return { toolCalls: [{ id: `call-${models}`, name: 'tick', arguments: {} }] }
    assert.equal(messages.filter(m => m.role === 'user').length, 1)
    assert.equal(messages.filter(m => m.role === 'tool').length, 2)
    return { content: 'done' }
  })
  h.tools.register({ name: 'tick', execute: () => { tools++; return 'done once' } })
  h.agent.budget = { maxModelRequests: 2 }
  await assert.rejects(h.agent.send('current task'), /max_steps/)
  const before = h.sessions.latestRun(h.session.id)!
  assert.equal(await h.agent.continue(), 'done')
  const after = h.sessions.latestRun(h.session.id)!
  assert.equal(after.taskId, before.taskId)
  assert.notEqual(after.runId, before.runId)
  assert.equal(after.previousRunId, before.runId)
  assert.equal(after.counters.modelRequests, 1)
  assert.equal(h.sessions.taskCounters(h.session.id, after.taskId).modelRequests, 3)
  assert.equal(h.sessions.taskCounters(h.session.id, after.taskId).toolCalls, 1)
  assert.equal(h.sessions.taskState(h.session.id, after.taskId).continuations, 1)
  assert.equal(tools, 1)
  assertToolProtocol(h.sessions.deriveMessages(h.session.id))
  const length = h.session.events.length
  await assert.rejects(h.agent.continue(), /already completed/)
  assert.equal(h.session.events.length, length)
})
test('continuation protects all prior runs and refuses unresolved tool outcomes', async () => {
  const h = harness(async () => ({ toolCalls: [{ id: 'a', name: 'tick', arguments: {} }] }))
  h.tools.register({ name: 'tick', execute: () => 'large output '.repeat(1000) })
  await assert.rejects(h.agent.send('current', { budget: { maxModelRequests: 2 } }), /max_steps/)
  const taskId = h.sessions.latestRun(h.session.id)!.taskId
  await assert.rejects(h.agent.continue({ budget: { maxModelRequests: 2, inputTargetTokens: 1000, contextWindowTokens: 10000, maxOutputTokens: 10 } }), /context_overflow/)
  assert.equal(h.sessions.latestRun(h.session.id)?.taskId, taskId)
  await assert.rejects(h.agent.continue({ budget: { maxModelRequests: 2, inputTargetTokens: 1000, contextWindowTokens: 10000, maxOutputTokens: 10 } }), /unchanged context/)
  const state = h.sessions.latestRun(h.session.id)!
  h.sessions.append(h.session.id, 'tool/result', { toolCallId: 'unknown', content: 'uncertain side effect', status: 'unknown' }, state)
  await assert.rejects(h.agent.continue({ budget: { contextWindowTokens: 20000, maxOutputTokens: 10 } }), /unknown tool outcome/)
  h.sessions.clear(h.session.id)
  await assert.rejects(h.agent.continue(), /no task/)
})
