import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { MemoryStore } from '../src/core/memory-store.js'
import { MemoryRuntime } from '../src/core/memory-runtime.js'
import { memoryDigest, memoryHash } from '../src/core/memory-contracts.js'
import { SessionRuntime } from '../src/core/session-runtime.js'
import { estimateText } from '../src/core/token-estimator.js'
import type { MemoryProposal } from '../src/core/memory-contracts.js'

async function setup(t: import('node:test').TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-recall-'))
  const workspace = path.join(directory, 'project'); await fs.mkdir(workspace)
  await fs.writeFile(path.join(workspace, 'entry.ts'), 'export const entry = true')
  const store = await MemoryStore.open({ directory: path.join(directory, 'memory'), workspace })
  const sessions = new SessionRuntime(), session = sessions.create({ workspace })
  const state = sessions.beginRun(session.id, {}, 'scripted/test')
  const source = sessions.append(session.id, 'user/message', { content: 'entry.ts defines the module entry; verify it before reuse.' }, state)
  const input: MemoryProposal = { kind: 'project_fact', key: 'module-entry', title: '模块入口 moduleEntry', content: '入口 entry.ts；需要重新核对文件版本。', tags: ['模块'], sources: [{ sessionId: session.id, taskId: state.taskId, eventId: source.id, seq: source.seq }], anchors: [{ path: 'entry.ts', contentSha256: memoryHash('export const entry = true') }] }
  const runtime = new MemoryRuntime(store)
  t.after(async () => { await store.close(); await fs.rm(directory, { recursive: true, force: true }) })
  const add = async (op: string, proposal: MemoryProposal = input) => { const record = await runtime.propose(op, proposal, sessions, session.id); return store.approve(`approve-${op}`, record.id, record.revision, memoryDigest(record)) }
  return { directory, workspace, store, runtime, sessions, session, state, input, add }
}

test('recall is approval-only, project-scoped and frozen per view; new views see newly approved records', async t => {
  const h = await setup(t), candidate = await h.runtime.propose('candidate', h.input, h.sessions, h.session.id)
  const old = await h.runtime.createView()
  assert.equal((await h.runtime.search(old, '模块')).items.length, 0)
  await h.store.approve('approve', candidate.id, candidate.revision, memoryDigest(candidate))
  assert.equal((await h.runtime.get(old, candidate.id)).items.length, 0)
  const current = await h.runtime.createView()
  assert.equal((await h.runtime.search(current, 'moduleEntry')).items[0].id, candidate.id)
  assert.equal((await h.runtime.search(current, '模块')).items.length, 1)
  await assert.rejects(h.runtime.search({ ...current, projectId: 'f'.repeat(64) }, 'entry'), /cross-project/)
  h.runtime.releaseView(current)
  await assert.rejects(h.runtime.get(current, candidate.id), /unknown/)
})

test('recall rejects expired, revoked, changed and unreachable evidence, including source corruption', async t => {
  const h = await setup(t), good = await h.add('good'), view = await h.runtime.createView()
  assert.equal((await h.runtime.get(view, good.id)).items.length, 1)
  await fs.writeFile(path.join(h.workspace, 'entry.ts'), 'changed')
  assert.equal((await h.runtime.get(view, good.id)).filtered['anchor-changed'], 1)
  assert.equal((await h.runtime.propose('good', h.input, h.sessions, h.session.id)).id, good.id)
  await assert.rejects(h.runtime.propose('good', { ...h.input, content: 'different operation' }, h.sessions, h.session.id), /opId reused/)
  await fs.writeFile(path.join(h.workspace, 'entry.ts'), 'export const entry = true')
  const artifact = path.join(h.store.directory, 'sources', `${good.sources[0].artifactSha256}.json`)
  await fs.writeFile(artifact, '{}')
  assert.equal((await h.runtime.get(view, good.id)).filtered['source-unavailable'], 1)
  await h.store.revoke('revoke', good.id, good.revision)
  assert.equal((await h.runtime.get(view, good.id)).items.length, 0)
  const future = new MemoryRuntime(h.store, {}, () => Date.parse('2100-01-01T00:00:00.000Z'))
  // Use a fresh confirmed source; corrupt source copies cannot silently be overwritten.
  await fs.unlink(artifact)
  const expiring = await h.add('expiring', { ...h.input, key: 'expires', expiresAt: '2099-01-01T00:00:00.000Z' })
  assert.equal((await future.get(await future.createView(), expiring.id)).filtered.expired, 1)
})

test('recall deterministically bounds complete records, metadata, estimated tokens and validation work', async t => {
  const h = await setup(t)
  for (let i = 0; i < 8; i++) await h.add(`p${i}`, { ...h.input, key: `entry-${i}`, content: '模块入口 '.repeat(80) })
  const runtime = new MemoryRuntime(h.store, { maxItems: 3, maxBytes: 2200, maxTokens: 900, maxCandidateChecks: 4 })
  const view = await runtime.createView(), first = await runtime.search(view, 'entry')
  assert.deepEqual(await runtime.search(view, 'entry'), first)
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 2200); assert.ok(estimateText(JSON.stringify(first)) <= 900)
  assert.ok(first.items.length < 3); assert.equal(first.candidateLimitReached, true)
  assert.ok(first.filtered.capacity)
  await assert.rejects(runtime.search(view, 'x'.repeat(1025)), /1024/)
  assert.equal((await runtime.search(view, 'unrelated')).items.length, 0)
})

test('memory persists minimal original sources across reset and rejects foreign, failed and oversized evidence', async t => {
  const h = await setup(t), approved = await h.add('good')
  h.sessions.finishRun(h.state, 'completed'); h.sessions.clear(h.session.id)
  assert.equal((await h.runtime.get(await h.runtime.createView(), approved.id)).items.length, 1)
  const state = h.sessions.beginRun(h.session.id, {}, 'scripted/test')
  await assert.rejects(h.runtime.propose('old-task', h.input, h.sessions, h.session.id), /confirmed allowed/)
  const failure = h.sessions.append(h.session.id, 'tool/result', { toolCallId: 'bad', status: 'unknown', isError: true, content: 'uncertain' }, state)
  await assert.rejects(h.runtime.propose('unknown', { ...h.input, sources: [{ sessionId: h.session.id, taskId: state.taskId, eventId: failure.id, seq: failure.seq }] }, h.sessions, h.session.id), /confirmed allowed/)
  const source = h.sessions.append(h.session.id, 'user/message', { content: 'x'.repeat(70 * 1024) }, state)
  await assert.rejects(h.runtime.propose('big', { ...h.input, sources: [{ sessionId: h.session.id, taskId: state.taskId, eventId: source.id, seq: source.seq }] }, h.sessions, h.session.id), /artifact limit/)
})
