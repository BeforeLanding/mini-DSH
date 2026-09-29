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
test('recovery preserves task state, adds unknown/skipped results and never executes tools', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-recover-'))
  const sessions = new SessionRuntime(), session = sessions.create({ workspace: root })
  const store = await JsonlStore.open(root, session.id)
  try {
    sessions.attachStore(session.id, store)
    const run = sessions.beginRun(session.id, {}, 'mock/demo')
    sessions.append(session.id, 'user/message', { content: 'mock task' }, run)
    sessions.append(session.id, 'assistant/tool_calls', { reasoningContent: 'reasoning', toolCalls: [{ id: 'a', name: 'write', arguments: {} }, { id: 'b', name: 'write', arguments: {} }] }, run)
    sessions.append(session.id, 'tool/start', { taskId: run.taskId, runId: run.runId, toolCallId: 'a', name: 'write' }, run)
    sessions.append(session.id, 'model/start', { taskId: run.taskId, runId: run.runId, requestId: 'partial-request', estimatedInputTokens: 400 }, run)
    sessions.append(session.id, 'model/fragment', { requestId: 'partial-request', content: 'unfinished', reasoningContent: 'reasoning' }, run)
    await fs.writeFile(path.join(root, 'side-effect.txt'), 'already executed')
    await sessions.flush(session.id); await store.close()
    const next = await JsonlStore.open(root, session.id), restored = new SessionRuntime()
    await assert.rejects(restored.restore(next, path.join(root, 'another')), /workspace mismatch/)
    await restored.restore(next, root)
    assert.equal(await fs.readFile(path.join(root, 'side-effect.txt'), 'utf8'), 'already executed')
    assert.equal(restored.latestRun(session.id)?.status, 'error')
    assert.equal(restored.latestRun(session.id)?.counters.toolCalls, 1)
    assert.equal(restored.latestRun(session.id)?.counters.modelRequests, 1)
    assert.equal(restored.latestRun(session.id)?.usage[0].inputTokens, 400)
    assert.equal(restored.latestRun(session.id)?.usage[0].uncertain, true)
    assert.equal(restored.deriveMessages(session.id).filter(m => m.role === 'assistant').length, 1)
    const results = restored.get(session.id).events.filter(e => e.type === 'tool/result')
    assert.deepEqual(results.map(e => e.data.status), ['unknown', 'skipped'])
    assert.equal(restored.deriveMessages(session.id)[1].reasoning_content, 'reasoning')
    restored.clear(session.id); await restored.flush(session.id); await next.close()
    const lastStore = await JsonlStore.open(root, session.id), last = new SessionRuntime()
    await last.restore(lastStore, root)
    assert.deepEqual(last.deriveMessages(session.id), [])
    assert.equal(last.latestRun(session.id), undefined)
    await lastStore.close()
  } finally { await store.close(); assert.equal(path.dirname(root), path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }) }
})
test('tail quarantine preserves original bytes and rejects middle damage or unknown payloads', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-tail-'))
  const session = new SessionRuntime().create(), store = await JsonlStore.open(root, session.id)
  try {
    await store.append(session.events[0]); await store.close()
    const target = path.join(store.directory, 'events.jsonl')
    await fs.appendFile(target, '{"partial":')
    const original = await fs.readFile(target, 'utf8')
    await assert.rejects(JsonlStore.open(root, session.id), /incomplete JSONL tail/)
    const backup = await JsonlStore.quarantineTail(root, session.id)
    assert.equal(await fs.readFile(backup, 'utf8'), original)
    const next = await JsonlStore.open(root, session.id)
    assert.equal((await next.read()).length, 1); await next.close()
    const malformed = structuredClone(session.events[0]) as unknown as Record<string, unknown>
    malformed.type = 'unknown/event'
    assert.throws(() => parseLog(JSON.stringify(malformed) + '\n', session.id), /invalid event payload/)
    malformed.type = 'user/message'; malformed.data = { content: 7 }
    assert.throws(() => parseLog(JSON.stringify(malformed) + '\n', session.id), /invalid event payload/)
    malformed.version = 99
    assert.throws(() => parseLog(JSON.stringify(malformed) + '\n', session.id), /envelope\/version/)
  } finally { await store.close(); assert.equal(path.dirname(root), path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }) }
})
