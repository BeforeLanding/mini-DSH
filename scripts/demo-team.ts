import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHarness } from '../src/app/create-harness.js'
import { JsonlStore } from '../src/core/event-store.js'
import { memoryHash } from '../src/core/memory-contracts.js'
import { inspectSession, formatInspect } from '../src/core/session-inspect.js'

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-team-demo-')), directory = path.resolve('.demo-runs', `team-${Date.now()}`)
await fs.writeFile(path.join(workspace, 'entry.ts'), 'export const entry = true')
// The scripted adapter supplies synthetic usage solely to exercise accounting. No provider is configured.
const usage = { inputTokens: 100, outputTokens: 10, totalTokens: 110, source: 'provider' as const, uncertain: false }
let step = 0, scriptedRequests = 0, scenario: string = 'success', cancelChildren = 0
let cancelReady!: () => void
const cancelStarted = new Promise<void>(resolve => { cancelReady = resolve })
const h = await createHarness({ workspace, profile: 'coding', delegation: { mode: 'read-only', directory: path.join(directory, 'teams') }, adapter: { provider: 'scripted', model: 'demo', capabilities: { demo: { contextWindowTokens: 1_000_000 } }, chat: async request => {
  scriptedRequests++
  if ((request.system ?? '').includes('You are a read-only')) {
    if (scenario === 'cancel') { if (++cancelChildren === 2) cancelReady(); return new Promise(() => {}) }
    if (scenario === 'invalid') return { usage, content: 'invalid structured response' }
    return { usage, content: JSON.stringify({ findings: [{ kind: 'observation', text: 'entry.ts exports true.', evidence: [{ path: 'entry.ts', contentSha256: memoryHash('export const entry = true') }] }], unresolved: [] }) }
  }
  if (step++ === 0) return { usage, toolCalls: [{ id: 'read', name: 'read_file', arguments: { path: 'entry.ts' } }] }
  if (step === 2) return { usage, toolCalls: [{ id: 'delegate', name: 'delegate_tasks', arguments: { tasks: (scenario === 'cancel' ? ['analyst', 'test_designer', 'analyst'] : ['analyst', 'test_designer']).map(role => ({ role, objective: 'Investigate the module', contextRefs: ['entry.ts'], outputFocus: 'Behavior and edge cases' })) } }] }
  return { usage, content: 'Both read-only investigations completed. Main-agent checks are still required.' }
} } })
try {
  const session = h.root.sessions.create({ workspace, source: 'scripted-mechanism-demo', syntheticUsage: true }), store = await JsonlStore.open(path.join(directory, 'sessions'), session.id)
  h.root.sessions.attachStore(session.id, store)
  const agent = h.root.agents.create({ sessionId: session.id, model: 'scripted/demo', loop: h.root.agentLoop })
  await agent.send('Investigate with two read-only workers.')
  assert.equal(h.root.sessions.get(session.id).events.filter(event => event.type === 'delegation/child-finish' && event.data.status === 'completed').length, 2)
  scenario = 'invalid'; step = 0
  await agent.send('Demonstrate invalid child output without pretending success.')
  assert.equal(h.root.sessions.get(session.id).events.filter(event => event.type === 'delegation/child-finish' && event.data.status === 'invalid_result').length, 2)
  scenario = 'cancel'; step = 0
  const controller = new AbortController(), cancelled = agent.send('Demonstrate cancellation with one queued child.', { signal: controller.signal })
  void cancelled.catch(() => {})
  await cancelStarted; controller.abort(); await assert.rejects(cancelled); await h.delegation!.close()
  assert.equal(cancelChildren, 2)
  await h.root.sessions.flush(session.id)
  const report = await inspectSession(path.join(store.directory, 'events.jsonl'), { tree: true })
  assert.equal(report.integrity.complete, true); assert.equal(report.coordination?.children.length, 7)
  assert.equal(report.coordination?.children.filter(child => child.status === 'skipped').length, 1)
  assert.equal(report.coordination?.groups.reduce((sum, group) => sum + group.requests, 0), scriptedRequests)
  assert.equal(report.coordination?.groups.at(-1)?.usageUnknown, 2)
  assert.equal(await fs.readFile(path.join(workspace, 'entry.ts'), 'utf8'), 'export const entry = true')
  console.log(formatInspect(report))
  console.log(`demo team: PASS; scriptedRequests=${scriptedRequests}; provider requests=0; usage above is synthetic, not a bill; evidence=${directory}`)
} finally { await h.root.sessions.close(); await h.dispose(); await fs.rm(workspace, { recursive: true, force: true }) }
