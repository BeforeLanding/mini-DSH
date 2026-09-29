import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { JsonlStore, parseLog } from '../src/core/event-store.js'
import { SessionRuntime } from '../src/core/session-runtime.js'
import { harness } from './harness.js'
test('JSONL writer serializes durable events and excludes a second writer', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-store-'))
  const sessions = new SessionRuntime(), session = sessions.create()
  const store = await JsonlStore.open(root, session.id)
  try {
    sessions.attachStore(session.id, store)
    await assert.rejects(JsonlStore.open(root, session.id), /writer lock/)
    sessions.append(session.id, 'user/message', { content: 'mock input' })
    sessions.clear(session.id)
    await sessions.flush(session.id)
    assert.deepEqual(await store.read(), session.events)
    await store.close()
    const reopened = await JsonlStore.open(root, session.id)
    assert.deepEqual(await reopened.read(), session.events)
    await reopened.close()
  } finally {
    await store.close()
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()))
    await fs.rm(root, { recursive: true, force: true })
  }
})
test('write failure stops before model or tool dispatch', async () => {
  let calls = 0
  const h = harness(async () => { calls++; return { content: 'ok' } })
  h.sessions.attachStore(h.session.id, { append: async () => { throw new Error('disk failed') }, read: async () => [], close: async () => {} })
  await assert.rejects(h.agent.send('mock input'), /disk failed/)
  assert.equal(calls, 0)
})
test('JSONL corruption, incomplete tail and duplicate sequences are distinct failures', () => {
  const s = new SessionRuntime().create()
  const line = JSON.stringify(s.events[0]) + '\n'
  assert.throws(() => parseLog(line + '{', s.id), /incomplete JSONL tail/)
  assert.throws(() => parseLog(line + '{\n', s.id), /corrupt JSONL record 2/)
  assert.throws(() => parseLog(line + line, s.id), /envelope\/version\/sequence/)
})
