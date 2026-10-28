import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { MemoryStore, memoryProjectId } from '../src/core/memory-store.js'
import { memoryDigest, memoryHash } from '../src/core/memory-contracts.js'
import type { MemoryProposal } from '../src/core/memory-contracts.js'

const proposal = (): MemoryProposal => ({ kind: 'project_fact', key: 'module', title: 'Module entry', content: 'The entry is src/main.ts.', tags: ['entry'], sources: [{ sessionId: randomUUID(), taskId: randomUUID(), eventId: randomUUID(), seq: 2 }], anchors: [{ path: 'src/main.ts', contentSha256: memoryHash('entry') }] })
async function fixture(t: import('node:test').TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-memory-'))
  const workspace = path.join(directory, 'workspace'); await fs.mkdir(workspace)
  const options = { directory: path.join(directory, 'memory'), workspace }
  const store = await MemoryStore.open(options)
  t.after(async () => { await store.close(); await fs.rm(directory, { recursive: true, force: true }) })
  return { directory, workspace, options, store }
}

test('memory persists candidates, exact approval, receipt idempotency and rebuildable index', async t => {
  const { store, options } = await fixture(t)
  const input = proposal(), candidate = await store.propose('proposal-1', input)
  assert.deepEqual(await store.propose('proposal-1', input), candidate)
  await assert.rejects(store.propose('proposal-1', { ...input, content: 'different' }), /opId reused/)
  await assert.rejects(store.approve('bad-approval', candidate.id, 1, '0'.repeat(64)), /mismatch/)
  const approved = await store.approve('approval-1', candidate.id, 1, memoryDigest(candidate))
  assert.equal(approved.state, 'approved'); assert.equal(approved.revision, 2)
  await store.rebuildIndex()
  await fs.writeFile(path.join(store.directory, 'index.json'), 'corrupt index')
  await store.close()
  const journal = path.join(store.directory, 'events.jsonl'), original = await fs.readFile(journal, 'utf8')
  const lines = original.trimEnd().split('\n'), corrupted = JSON.parse(lines[1])
  corrupted.records[0].content = 'Tampered approved content'
  await fs.writeFile(journal, lines[0] + '\n' + JSON.stringify(corrupted) + '\n')
  await assert.rejects(MemoryStore.open(options), /immutable content/)
  await fs.writeFile(journal, original)
  const reopened = await MemoryStore.open(options)
  try {
    assert.deepEqual(await reopened.get(candidate.id), approved)
    assert.deepEqual(await reopened.propose('proposal-1', input), candidate)
    assert.deepEqual(await reopened.approve('approval-1', candidate.id, 1, memoryDigest(candidate)), approved)
    await reopened.rebuildIndex()
    const index = JSON.parse(await fs.readFile(path.join(store.directory, 'index.json'), 'utf8'))
    assert.equal(index.seq, 2); assert.deepEqual(index.records, [approved])
  } finally { await reopened.close() }
})

test('memory isolates projects, locks writers, supports explicit read-only/shared bindings and rejects traversal', async t => {
  const { store, options, directory } = await fixture(t)
  const candidate = await store.propose('p', proposal())
  await assert.rejects(MemoryStore.open(options), /writer lock/)
  const reader = await MemoryStore.open({ ...options, readOnly: true })
  try { assert.deepEqual(await reader.get(candidate.id), candidate); await assert.rejects(reader.propose('no', proposal()), /read-only/) } finally { await reader.close() }
  const workspace2 = path.join(directory, 'other'); await fs.mkdir(workspace2)
  const isolated = await MemoryStore.open({ ...options, workspace: workspace2 })
  try { assert.notEqual(store.projectId, isolated.projectId); assert.deepEqual(await isolated.records(), []) } finally { await isolated.close() }
  const bound = await MemoryStore.open({ ...options, workspace: workspace2, projectId: store.projectId, readOnly: true })
  try { assert.equal((await bound.records()).length, 1) } finally { await bound.close() }
  await assert.rejects(MemoryStore.open({ ...options, projectId: '../other' }), /project id/)
  assert.equal(await memoryProjectId(options.workspace), store.projectId)
})

test('memory serializes CAS, preserves conflicting candidates and atomically supersedes the approved version', async t => {
  const { store } = await fixture(t)
  const first = await store.propose('p1', proposal())
  const outcomes = await Promise.allSettled([store.approve('a1', first.id, 1, memoryDigest(first)), store.revoke('r1', first.id, 1)])
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1)
  const approved = (await store.get(first.id))!
  assert.equal(approved.state, 'approved')
  const conflict = await store.propose('p2', proposal())
  await assert.rejects(store.approve('a2', conflict.id, 1, memoryDigest(conflict)), /conflicting/)
  const replacement = await store.propose('p3', { ...proposal(), content: 'New entry', supersedes: { id: first.id, revision: approved.revision } })
  await store.approve('a3', replacement.id, 1, memoryDigest(replacement))
  assert.equal((await store.get(first.id))?.state, 'superseded')
  assert.equal((await store.get(conflict.id))?.state, 'candidate')
  assert.equal((await store.get(replacement.id))?.state, 'approved')
  await assert.rejects(store.revoke('stale', replacement.id, 1), /revision mismatch/)
})

test('memory rejects oversized input and stops adding records at configured capacity without poisoning writes', async t => {
  const { options, store } = await fixture(t)
  await store.close()
  const bounded = await MemoryStore.open({ ...options, limits: { maxActiveRecords: 1 } })
  try {
    await assert.rejects(bounded.propose('large', { ...proposal(), content: '中'.repeat(700) }), /invalid memory/)
    await assert.rejects(bounded.propose('path', { ...proposal(), anchors: [{ path: '../secret', contentSha256: memoryHash('x') }] }), /invalid memory/)
    const candidate = await bounded.propose('p', proposal())
    await assert.rejects(bounded.propose('p2', proposal()), /active memory limit/)
    await bounded.revoke('r', candidate.id, 1)
    assert.equal((await bounded.propose('p3', proposal())).state, 'candidate')
  } finally { await bounded.close() }
})

test('memory refuses corrupt sequence, UTF-8, versions and partial tails while preserving bytes and releasing failed-open locks', async t => {
  const { store, options } = await fixture(t)
  await store.propose('p', proposal()); await store.close()
  const target = path.join(store.directory, 'events.jsonl'), original = await fs.readFile(target)
  const event = JSON.parse(original.toString('utf8'))
  for (const bytes of [Buffer.concat([original, Buffer.from('{')]), Buffer.from([0xff, 10]), Buffer.from(JSON.stringify({ ...event, version: 2 }) + '\n'), Buffer.from(JSON.stringify({ ...event, seq: 3 }) + '\n')]) {
    await fs.writeFile(target, bytes)
    await assert.rejects(MemoryStore.open(options))
    assert.deepEqual(await fs.readFile(target), bytes)
    await assert.rejects(fs.stat(path.join(store.directory, 'writer.lock')), { code: 'ENOENT' })
  }
  await fs.writeFile(target, original)
  const reopened = await MemoryStore.open(options); await reopened.close()
})
