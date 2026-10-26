import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { createHarness } from '../src/app/create-harness.js'
import { JsonlStore, parseLog } from '../src/core/event-store.js'
import { delegationLimits } from '../src/core/delegation-contracts.js'
import type { DelegationBatch } from '../src/core/delegation-contracts.js'

for (const window of ['reserved', 'dispatched', 'settled', 'artifact'] as const) test(`delegation recovers the ${window} crash window without repeating a provider request`, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'delegation-recovery-')), workspace = path.join(directory, 'project'), teams = path.join(directory, 'teams'), logs = path.join(directory, 'logs')
  await fs.mkdir(workspace)
  let providerCalls = 0
  const config = { workspace, profile: 'coding' as const, delegation: { mode: 'read-only' as const, directory: teams }, adapter: { provider: 'scripted', model: 'test', chat: async () => { providerCalls++; throw new Error('recovery must never invoke the model') } } }
  const h = await createHarness(config), session = h.root.sessions.create({ workspace }), store = await JsonlStore.open(logs, session.id)
  h.root.sessions.attachStore(session.id, store)
  const state = h.root.sessions.beginRun(session.id, {}, 'scripted/test')
  h.root.sessions.append(session.id, 'user/message', { content: 'Investigate without editing.' }, state)
  const batch = h.root.sessions.append(session.id, 'assistant/tool_calls', { toolCalls: [{ id: 'delegate', name: 'delegate_tasks', arguments: { tasks: [] } }] }, state)
  h.root.sessions.append(session.id, 'tool/start', { taskId: state.taskId, runId: state.runId, toolCallId: 'delegate', name: 'delegate_tasks' }, state)
  const group = await h.taskGroups!.get(session.id, state.taskId)
  const batchId = randomUUID(), first = randomUUID(), second = randomUUID(), childSessionId = randomUUID()
  const childTask = { role: 'analyst' as const, objective: 'Investigate', contextRefs: [], outputFocus: 'evidence' }
  h.root.sessions.append(session.id, 'delegation/start', { batchId, groupId: group.start.groupId, toolCallId: 'delegate', toolSequence: batch.seq, anchors: [], limits: { ...delegationLimits() }, children: [{ delegationId: first, task: childTask }, { delegationId: second, task: childTask }] }, state)
  h.root.sessions.append(session.id, 'delegation/child-created', { batchId, delegationId: first, childSessionId, role: 'analyst', capabilityDigest: 'a'.repeat(64) }, state)
  await group.reserve({ sessionId: childSessionId, taskId: randomUUID(), runId: randomUUID(), requestId: 'child-request', agentId: childSessionId, root: false, purpose: 'main', reserve: 1000 })
  if (window !== 'reserved') await group.dispatched('child-request')
  if (window === 'settled' || window === 'artifact') await group.settle('child-request', { inputTokens: 100, outputTokens: 10, totalTokens: 110, source: 'provider', uncertain: false })
  if (window === 'artifact') {
    const target = path.join(teams, session.id, batchId); await fs.mkdir(target, { recursive: true })
    await fs.writeFile(path.join(target, `${first}.json`), JSON.stringify({ delegationId: first, childSessionId, status: 'completed', findings: [], unresolved: ['No observation confirmed.'] }))
  }
  await h.root.sessions.flush(session.id); await h.root.sessions.close(); await h.dispose()
  const recovered = await createHarness(config)
  t.after(async () => {
    await recovered.root.sessions.close(); await recovered.dispose()
    if (process.env.MINI_DSH_MEMORY_TEAM_EVIDENCE) {
      const target = path.join(path.resolve(process.env.MINI_DSH_MEMORY_TEAM_EVIDENCE), window)
      await fs.cp(directory, target, { recursive: true, force: false, errorOnExist: true })
      t.diagnostic(`synthetic recovery evidence: ${target}`)
    }
    await fs.rm(directory, { recursive: true, force: true })
  })
  const reopened = await JsonlStore.open(logs, session.id)
  await recovered.root.sessions.restore(reopened, workspace)
  const events = recovered.root.sessions.get(session.id).events
  const result = events.find(event => event.type === 'tool/result' && event.data.toolCallId === 'delegate')!
  assert.equal(result.type === 'tool/result' ? result.data.status : '', 'completed')
  const value: DelegationBatch = JSON.parse(result.type === 'tool/result' ? result.data.content : '')
  assert.equal(value.results[0].status, window === 'artifact' ? 'completed' : 'interrupted')
  assert.equal(value.results[1].status, 'skipped')
  assert.equal(providerCalls, 0); assert.equal(recovered.root.sessions.latestRun(session.id)?.status, 'error')
  const restoredGroup = await recovered.taskGroups!.get(session.id, state.taskId)
  assert.equal(restoredGroup.snapshot().usageUnknown, window === 'dispatched')
  assert.equal(restoredGroup.snapshot().settledTokens, window === 'settled' || window === 'artifact' ? 110 : 0)
  assert.equal(restoredGroup.start.deadline, group.start.deadline)
  parseLog(events.map(event => JSON.stringify(event) + '\n').join(''), session.id)
  assert.equal(events.filter(event => event.type === 'tool/result' && event.data.toolCallId === 'delegate').length, 1)
})

test('parent cancellation reaches running children, leaves queued children unstarted and records unknown usage honestly', { timeout: 10000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'delegation-cancel-')), workspace = path.join(directory, 'project')
  await fs.mkdir(workspace)
  let children = 0, both!: () => void; const started = new Promise<void>(resolve => { both = resolve })
  const childTask = { role: 'analyst', objective: 'Investigate', contextRefs: [], outputFocus: 'evidence' }
  const h = await createHarness({ workspace, profile: 'coding', delegation: { mode: 'read-only', directory: path.join(directory, 'teams') }, adapter: { provider: 'scripted', model: 'test', capabilities: { test: { contextWindowTokens: 1_000_000 } }, chat: async request => {
    if (/You are a read-only/.test(request.system ?? '')) { children++; if (children === 2) both(); return new Promise(() => {}) }
    return { usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20, source: 'provider', uncertain: false }, toolCalls: [{ id: 'delegate', name: 'delegate_tasks', arguments: { tasks: [childTask, childTask, childTask] } }] }
  } } })
  t.after(async () => { await h.dispose(); await fs.rm(directory, { recursive: true, force: true }) })
  const session = h.root.sessions.create({ workspace }), agent = h.root.agents.create({ sessionId: session.id, model: 'scripted/test', loop: h.root.agentLoop }), controller = new AbortController()
  const running = agent.send('Investigate.', { signal: controller.signal }); void running.catch(() => {})
  await started
  await assert.rejects(h.delegation!.run([], { sessionId: session.id, toolCallId: 'concurrent', toolSequence: 999, agent, signal: new AbortController().signal }), /one active parent batch/)
  controller.abort(); await assert.rejects(running)
  await h.delegation!.close()
  assert.equal(children, 2)
  const events = h.root.sessions.get(session.id).events
  assert.equal(events.filter(event => event.type === 'delegation/child-created').length, 2)
  const finishes = events.filter(event => event.type === 'delegation/child-finish')
  assert.equal(finishes.filter(event => event.type === 'delegation/child-finish' && event.data.status === 'skipped').length, 1)
  const state = h.root.sessions.latestRun(session.id)!
  assert.equal((await h.taskGroups!.get(session.id, state.taskId)).snapshot().usageUnknown, true)
  assert.equal(events.filter(event => event.type === 'tool/result' && event.data.toolCallId === 'delegate').length, 1)
})
