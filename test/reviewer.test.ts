import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHarness } from '../src/app/create-harness.js'
import { memoryHash } from '../src/core/memory-contracts.js'
import { parseLog } from '../src/core/event-store.js'
import type { DelegationBatch } from '../src/core/delegation-contracts.js'

const before = 'export const entry = false', after = 'export const entry = true'
const usage = { inputTokens: 100, outputTokens: 2, totalTokens: 102, source: 'provider' as const, uncertain: false }
test('reviewer sees the fixed candidate diff; a subsequent root edit invalidates its review without authorizing writes or verification', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'review-candidate-')), workspace = path.join(directory, 'project')
  await fs.mkdir(workspace); await fs.writeFile(path.join(workspace, 'entry.ts'), before)
  const tools = [
    { id: 'read', name: 'read_file', arguments: { path: 'entry.ts' } },
    { id: 'edit', name: 'write_file', arguments: { path: 'entry.ts', content: after, expectedHash: memoryHash(before) } },
    { id: 'reread', name: 'read_file', arguments: { path: 'entry.ts' } },
    { id: 'review', name: 'delegate_tasks', arguments: { tasks: [{ role: 'reviewer', objective: 'Review this change', contextRefs: ['entry.ts'], outputFocus: 'Boundary bugs' }] } },
    { id: 'status', name: 'review_status', arguments: {} },
    { id: 'edit-again', name: 'write_file', arguments: { path: 'entry.ts', content: before, expectedHash: memoryHash(after) } },
    { id: 'status', name: 'review_status', arguments: {} },
  ]
  let step = 0; const statuses: string[] = []; let batch: DelegationBatch | undefined
  const h = await createHarness({ workspace, profile: 'coding', autoApprove: true, delegation: { mode: 'read-only', directory: path.join(directory, 'teams') }, adapter: { provider: 'scripted', model: 'test', capabilities: { test: { contextWindowTokens: 1_000_000 } }, chat: async request => {
    if ((request.system ?? '').includes('You are a read-only reviewer')) {
      const input = JSON.parse(request.messages![0].content!)
      assert.equal(input.candidate.anchors[0].contentSha256, memoryHash(after))
      assert.match(input.candidateDiff[0].diff, /-export const entry = false/)
      assert.match(input.candidateDiff[0].diff, /\+export const entry = true/)
      assert.ok(!request.tools!.some(tool => ['write_file', 'bash', 'delegate_tasks', 'memory_propose'].includes(tool.function.name)))
      return { usage, content: JSON.stringify({ findings: [{ kind: 'recommendation', text: 'Check callers that expect false.', evidence: [{ path: 'entry.ts', contentSha256: memoryHash(after) }] }], unresolved: ['Public checks still need execution by the main agent.'] }) }
    }
    return step < tools.length ? { usage, toolCalls: [tools[step++]] } : { usage, content: 'Review was invalidated by a later edit; checks remain unverified.' }
  } } })
  t.after(async () => { await h.dispose(); await fs.rm(directory, { recursive: true, force: true }) })
  const session = h.root.sessions.create({ workspace }), agent = h.root.agents.create({ sessionId: session.id, model: 'scripted/test', loop: h.root.agentLoop })
  await agent.send('Edit, review, then change the candidate.', { onToolResult(result) {
    assert.equal(result.isError, false, result.renderedContent)
    if (result.name === 'delegate_tasks') batch = result.value as DelegationBatch
    if (result.name === 'review_status') statuses.push((result.value as { reviews: { validity: string }[] }).reviews[0].validity)
  } })
  assert.equal(batch?.results[0].status, 'completed'); assert.ok(batch?.results[0].candidate?.digest)
  assert.deepEqual(statuses, ['current', 'stale'])
  assert.equal(h.root.sessions.get(session.id).events.filter(event => event.type === 'verification/result').length, 0)
  parseLog(h.root.sessions.get(session.id).events.map(event => JSON.stringify(event) + '\n').join(''), session.id)
})

test('external changes during review produce stale rather than a completed approval, including an empty finding list', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'review-stale-')), workspace = path.join(directory, 'project')
  await fs.mkdir(workspace); await fs.writeFile(path.join(workspace, 'entry.ts'), before)
  let step = 0, batch: DelegationBatch | undefined
  const h = await createHarness({ workspace, profile: 'coding', delegation: { mode: 'read-only', directory: path.join(directory, 'teams') }, adapter: { provider: 'scripted', model: 'test', capabilities: { test: { contextWindowTokens: 1_000_000 } }, chat: async request => {
    if ((request.system ?? '').includes('You are a read-only reviewer')) { await fs.writeFile(path.join(workspace, 'entry.ts'), 'external user change'); return { usage, content: JSON.stringify({ findings: [], unresolved: [] }) } }
    if (step++ === 0) return { usage, toolCalls: [{ id: 'read', name: 'read_file', arguments: { path: 'entry.ts' } }] }
    if (step === 2) return { usage, toolCalls: [{ id: 'review', name: 'delegate_tasks', arguments: { tasks: [{ role: 'reviewer', objective: 'Review module', contextRefs: ['entry.ts'], outputFocus: 'Behavior' }] } }] }
    return { usage, content: 'done' }
  } } })
  t.after(async () => { await h.dispose(); await fs.rm(directory, { recursive: true, force: true }) })
  const session = h.root.sessions.create({ workspace }), agent = h.root.agents.create({ sessionId: session.id, model: 'scripted/test', loop: h.root.agentLoop })
  await agent.send('Review only.', { onToolResult(result) { if (result.name === 'delegate_tasks') batch = result.value as DelegationBatch } })
  assert.equal(batch?.results[0].status, 'stale')
  assert.equal((await h.delegation!.reviewStatus(session.id)).reviews[0].validity, 'stale')
})
