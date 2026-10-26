import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHarness } from '../src/app/create-harness.js'
import { JsonlStore, parseLog } from '../src/core/event-store.js'
import { memoryDigest, memoryHash } from '../src/core/memory-contracts.js'
import { inspectSession } from '../src/core/session-inspect.js'
import { boundDelegationBatch, delegationLimits, parseChildFindings } from '../src/core/delegation-contracts.js'
import type { ChatRequest, ChatResponse } from '../src/core/contracts.js'
import type { DelegationBatch } from '../src/core/delegation-contracts.js'

const usage = { inputTokens: 100, outputTokens: 2, totalTokens: 102, source: 'provider' as const, uncertain: false }
const task = (role: 'analyst' | 'test_designer' = 'analyst') => ({ role, objective: 'Investigate the entry module', contextRefs: ['entry.ts'], outputFocus: 'Module behavior and boundary cases' })

test('delegate_tasks runs two read-only workers, queues additional children, accounts the shared budget and publishes parent-owned evidence', { timeout: 15000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'delegate-harness-')), workspace = path.join(directory, 'project'), teams = path.join(directory, 'teams')
  await fs.mkdir(workspace); await fs.writeFile(path.join(workspace, 'entry.ts'), 'export const entry = true')
  let rootCalls = 0, providerCalls = 0, active = 0, peak = 0
  let enterBoth!: () => void; const both = new Promise<void>(resolve => { enterBoth = resolve })
  const batches: DelegationBatch[] = [], errors: string[] = []
  const adapter = { provider: 'scripted', model: 'test', capabilities: { test: { contextWindowTokens: 1_000_000 } }, chat: async (request: ChatRequest): Promise<ChatResponse> => {
    providerCalls++
    const child = /You are a read-only (?:analyst|test_designer)/.test(request.system ?? '')
    if (child) {
      const tools = request.tools!.map(schema => schema.function.name)
      assert.ok(!tools.includes('bash')); assert.ok(!tools.includes('write_file')); assert.ok(!tools.includes('delegate_tasks'))
      if (request.messages!.at(-1)?.role === 'user') {
        active++; peak = Math.max(peak, active); if (active === 2) enterBoth()
        await both; active--
        return { usage, toolCalls: [{ id: 'child-read', name: 'read_file', arguments: { path: 'entry.ts' } }] }
      }
      return { usage, content: JSON.stringify({ findings: [{ kind: 'observation', text: 'The entry exports true.', evidence: [{ path: 'entry.ts', contentSha256: memoryHash('export const entry = true'), line: 1 }] }], unresolved: [] }) }
    }
    if (rootCalls++ === 0) return { usage, toolCalls: [{ id: 'parent-read', name: 'read_file', arguments: { path: 'entry.ts' } }] }
    if (rootCalls === 2) return { usage, toolCalls: [{ id: 'team', name: 'delegate_tasks', arguments: { tasks: [task(), task('test_designer'), task(), task('test_designer')] } }] }
    if (rootCalls === 3) return { usage, toolCalls: [{ id: 'too-many', name: 'delegate_tasks', arguments: { tasks: [task()] } }] }
    return { usage, content: 'Investigations collected; main agent retains edit and verification responsibility.' }
  } }
  const h = await createHarness({ workspace, profile: 'coding', adapter, memory: { mode: 'assist', directory: path.join(directory, 'memory') }, delegation: { mode: 'read-only', directory: teams } })
  t.after(async () => { await h.root.sessions.close(); await h.dispose(); await fs.rm(directory, { recursive: true, force: true }) })
  const session = h.root.sessions.create({ workspace }), logs = path.join(directory, 'logs'), store = await JsonlStore.open(logs, session.id)
  h.root.sessions.attachStore(session.id, store)
  const preparation = h.root.sessions.beginRun(session.id, {}, 'host/no-model')
  const source = h.root.sessions.append(session.id, 'user/message', { content: 'The module entry is entry.ts.' }, preparation)
  const candidate = await h.memory!.runtime.propose('seed', { kind: 'project_fact', key: 'module-entry', title: 'Entry', content: 'The module entry is entry.ts.', sources: [{ sessionId: session.id, taskId: preparation.taskId, eventId: source.id, seq: source.seq }], anchors: [{ path: 'entry.ts', contentSha256: memoryHash('export const entry = true') }] }, h.root.sessions, session.id)
  await h.memory!.command(['approve', candidate.id, '1', memoryDigest(candidate)])
  h.root.sessions.finishRun(preparation, 'completed'); await h.root.sessions.flush(session.id)
  const agent = h.root.agents.create({ sessionId: session.id, model: 'scripted/test', loop: h.root.agentLoop })
  await agent.send('Investigate module responsibilities and tests.', { onToolResult(result) { if (result.name === 'delegate_tasks') { if (result.isError) errors.push(result.renderedContent); else batches.push(result.value as DelegationBatch) } } })
  assert.equal(peak, 2); assert.equal(batches.length, 1); assert.equal(batches[0].results.length, 4)
  assert.ok(batches[0].results.every(result => result.status === 'completed'))
  assert.match(errors[0], /cumulative child limit/)
  const state = h.root.sessions.latestRun(session.id)!, group = await h.taskGroups!.get(session.id, state.taskId)
  assert.equal(group.snapshot().requests, providerCalls); assert.equal(providerCalls, 12)
  assert.equal(group.snapshot().settledTokens, providerCalls * 102); assert.equal(group.snapshot().tools, 7)
  const first = batches[0].results[0]
  const tool = h.root.tools.get('read_tool_result')!
  const read = await tool.execute({ ref: first.resultRef }, { sessionId: session.id, signal: new AbortController().signal }) as { content: string }
  assert.match(JSON.stringify(read), /The entry exports true/)
  await assert.rejects(Promise.resolve().then(() => tool.execute({ ref: first.resultRef }, { sessionId: first.childSessionId, signal: new AbortController().signal })), /owner|session/i)
  await h.root.sessions.flush(session.id)
  parseLog((await store.read()).map(event => JSON.stringify(event) + '\n').join(''), session.id)
  const inspection = await inspectSession(path.join(logs, session.id, 'events.jsonl'))
  assert.equal(inspection.integrity.complete, true)
  const parentView = h.root.sessions.get(session.id).events.find(event => event.type === 'memory/view' && event.taskId === state.taskId)!
  for (const result of batches[0].results) {
    const childEvents = (await fs.readFile(path.join(teams, 'sessions', result.childSessionId!, 'events.jsonl'), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line))
    const childLog = childEvents[0]
    assert.equal(childLog.data.meta.parentSessionId, session.id)
    assert.equal(childLog.data.meta.delegationId, result.delegationId)
    assert.equal(childEvents.find(event => event.type === 'memory/view').data.digest, parentView.type === 'memory/view' ? parentView.data.digest : '')
  }
  assert.equal((await h.memory!.runtime.store.get(candidate.id))?.state, 'approved')
})

test('invalid child results, foreign context refs and nested roles fail visibly without workspace edits', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'delegate-invalid-')), workspace = path.join(directory, 'project')
  await fs.mkdir(workspace); await fs.writeFile(path.join(workspace, 'entry.ts'), 'entry')
  let rootCalls = 0
  const errors: string[] = []
  const h = await createHarness({ workspace, profile: 'coding', delegation: { mode: 'read-only', directory: path.join(directory, 'teams') }, adapter: { provider: 'scripted', model: 'test', capabilities: { test: { contextWindowTokens: 1_000_000 } }, chat: async request => {
    if (/You are a read-only/.test(request.system ?? '')) return { usage, content: 'not JSON' }
    if (rootCalls++ === 0) return { usage, toolCalls: [{ id: 'foreign', name: 'delegate_tasks', arguments: { tasks: [{ ...task(), contextRefs: ['../outside'] }] } }] }
    if (rootCalls === 2) return { usage, toolCalls: [{ id: 'read', name: 'read_file', arguments: { path: 'entry.ts' } }] }
    if (rootCalls === 3) return { usage, toolCalls: [{ id: 'delegate', name: 'delegate_tasks', arguments: { tasks: [task()] } }] }
    if (rootCalls === 4) return { usage, toolCalls: [{ id: 'recursive', name: 'delegate_tasks', arguments: { tasks: [{ ...task(), role: 'coordinator' }] } }] }
    return { usage, content: 'done' }
  } } })
  t.after(async () => { await h.dispose(); await fs.rm(directory, { recursive: true, force: true }) })
  const session = h.root.sessions.create({ workspace }), agent = h.root.agents.create({ sessionId: session.id, model: 'scripted/test', loop: h.root.agentLoop })
  let batch: DelegationBatch | undefined
  await agent.send('Investigate.', { onToolResult(result) { if (result.name === 'delegate_tasks') { if (result.isError) errors.push(result.renderedContent); else batch = result.value as DelegationBatch } } })
  assert.equal(errors.length, 2)
  assert.equal(batch?.results[0].status, 'invalid_result')
  assert.equal(await fs.readFile(path.join(workspace, 'entry.ts'), 'utf8'), 'entry')
  assert.throws(() => parseChildFindings(JSON.stringify({ findings: [{ kind: 'observation', text: 'claim', evidence: [] }], unresolved: [] }), delegationLimits()), /evidence/)
  assert.throws(() => boundDelegationBatch({ batchId: 'b', results: [{ delegationId: 'a', status: 'failed', findings: [], unresolved: [] }], truncated: false }, { ...delegationLimits(), maxBatchResultBytes: 1 }), /cannot fit/)
})
