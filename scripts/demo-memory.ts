import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHarness } from '../src/app/create-harness.js'
import { memoryDigest, memoryHash } from '../src/core/memory-contracts.js'
import { MemoryRuntime } from '../src/core/memory-runtime.js'

// Host-driven mechanism demo; no .env, provider adapter or model request.
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-memory-demo-')), workspace = path.join(directory, 'project')
await fs.mkdir(workspace); await fs.writeFile(path.join(workspace, 'entry.ts'), 'entry-v1')
const h = await createHarness({ workspace, profile: 'coding', memory: { mode: 'assist', directory: path.join(directory, 'memory') } })
try {
  const session = h.root.sessions.create({ workspace }), state = h.root.sessions.beginRun(session.id, {}, 'host/no-model')
  const source = h.root.sessions.append(session.id, 'user/message', { content: 'The module entry is entry.ts. Check its current version before reuse.' }, state)
  const candidate = await h.memory!.runtime.propose('demo-proposal', { kind: 'project_fact', key: 'entry', title: 'Module entry', content: 'The module entry is entry.ts.', sources: [{ sessionId: session.id, taskId: state.taskId, eventId: source.id, seq: source.seq }], anchors: [{ path: 'entry.ts', contentSha256: memoryHash('entry-v1') }], expiresAt: new Date(Date.now() + 60_000).toISOString() }, h.root.sessions, session.id)
  assert.equal((await h.memory!.query(session.id, 'entry')).items.length, 0)
  console.log('candidate excluded: PASS')
  h.root.sessions.finishRun(state, 'completed')
  await h.memory!.command(['approve', candidate.id, '1', memoryDigest(candidate)])
  const nextSession = h.root.sessions.create({ workspace }), next = h.root.sessions.beginRun(nextSession.id, {}, 'host/no-model')
  const recalled = await h.memory!.query(nextSession.id, 'entry')
  assert.equal(recalled.items[0]?.id, candidate.id)
  console.log('new session recall with approved version and source: PASS')
  await fs.writeFile(path.join(workspace, 'entry.ts'), 'entry-v2')
  assert.equal((await h.memory!.query(nextSession.id, 'entry')).filtered['anchor-changed'], 1)
  console.log('changed file rejects stale memory: PASS')
  const future = new MemoryRuntime(h.memory!.runtime.store, {}, () => Date.now() + 120_000)
  assert.equal((await future.get(await future.createView(), candidate.id)).filtered.expired, 1)
  console.log('expiry rejects recall (simulated clock): PASS')
  h.root.sessions.finishRun(next, 'completed')
  console.log('demo memory: PASS; mechanism only; provider requests=0')
} finally { await h.dispose(); await fs.rm(directory, { recursive: true, force: true }) }
