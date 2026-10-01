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
    await fs.appendFile(target, Buffer.from([0xe4, 0xb8]))
    const original = await fs.readFile(target)
    await assert.rejects(JsonlStore.open(root, session.id), /incomplete JSONL tail/)
    const backup = await JsonlStore.quarantineTail(root, session.id)
    assert.deepEqual(await fs.readFile(backup), original)
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
test('usage or terminal persistence failure is surfaced as error and forbids new dispatch', async () => {
  for (const failType of ['model/usage', 'run/finish']) {
    let models = 0, tools = 0
    const h = harness(async () => { models++; return failType === 'model/usage' ? { toolCalls: [{ id: 'a', name: 'tick', arguments: {} }] } : { content: 'answer' } })
    h.tools.register({ name: 'tick', execute: () => { tools++; return 'ok' } })
    h.sessions.attachStore(h.session.id, { append: async event => { if (event.type === failType) throw new Error('sync failed') }, read: async () => [], close: async () => {} })
    await assert.rejects(h.agent.send('mock'), /sync failed/)
    assert.equal(models, 1)
    assert.equal(tools, 0)
    assert.equal(h.sessions.latestRun(h.session.id)?.status, 'error')
    assert.equal(h.sessions.latestRun(h.session.id)?.counters.toolCalls, 0)
    assert.ok(h.session.events.filter(e => e.type === 'tool/result').every(e => e.data.status === 'skipped'))
    await assert.rejects(h.agent.send('next'), /storage failed/)
    assert.equal(models, 1)
  }
})

test('crash replay unions only this run projections and restores the latest attempted input estimate', async () => {
  const sessions = new SessionRuntime(), session = sessions.create()
  const previous = sessions.beginRun(session.id, {}, 'mock/demo')
  sessions.append(session.id, 'context/projection', { estimatedInputTokens: 9999, reservedOutputTokens: 10, safetyMarginTokens: 2048, removedTaskIds: ['other-run'] }, previous)
  sessions.finishRun(previous, 'max_steps')
  const run = sessions.beginRun(session.id, {}, 'mock/demo', true)
  const snapshots = [structuredClone(session.events)]
  const project = (estimatedInputTokens: number, removedTaskIds: string[]) => {
    sessions.append(session.id, 'context/projection', { estimatedInputTokens, reservedOutputTokens: 10, safetyMarginTokens: 2048, removedTaskIds }, run)
    snapshots.push(structuredClone(session.events))
  }
  project(1234, ['old-a'])
  sessions.append(session.id, 'model/start', { taskId: run.taskId, runId: run.runId, requestId: 'first', estimatedInputTokens: 1234 }, run)
  snapshots.push(structuredClone(session.events))
  sessions.append(session.id, 'model/usage', { taskId: run.taskId, runId: run.runId, requestId: 'first', usage: { inputTokens: 1234, outputTokens: 10, totalTokens: 1244, source: 'provider', uncertain: false } }, run)
  snapshots.push(structuredClone(session.events))
  project(900, ['old-a', 'old-b'])
  sessions.append(session.id, 'model/start', { taskId: run.taskId, runId: run.runId, requestId: 'second', estimatedInputTokens: 900 }, run)
  snapshots.push(structuredClone(session.events))
  project(800, [])
  for (const raw of snapshots) {
    const projections = raw.flatMap(e => e.type === 'context/projection' && e.runId === run.runId ? [e.data] : [])
    const expectedIds = [...new Set(projections.flatMap(data => data.removedTaskIds))]
    const estimate = projections.at(-1)?.estimatedInputTokens
    const restored = new SessionRuntime()
    await restored.restore({ read: async () => raw, append: async () => {}, close: async () => {} })
    const state = restored.latestRun(session.id)!
    assert.equal(state.status, 'error')
    assert.equal(state.runId, run.runId)
    assert.equal(state.taskId, previous.taskId)
    assert.deepEqual(state.removedTaskIds, expectedIds)
    assert.equal(state.estimatedInputTokens, estimate)
    assert.equal(state.counters.modelRequests, raw.filter(e => e.type === 'model/start' && e.runId === run.runId).length)
    if (raw.some(e => e.type === 'model/start' && e.data.requestId === 'second')) assert.equal(state.usage.at(-1)?.inputTokens, 900)
    assert.deepEqual(restored.get(session.id).events.slice(0, raw.length), raw)
    assert.equal(restored.get(session.id).events.filter(e => e.type === 'run/finish' && e.runId === run.runId).length, 1)
    const sealed = structuredClone(restored.get(session.id).events)
    const reopened = new SessionRuntime()
    await reopened.restore({ read: async () => sealed, append: async () => {}, close: async () => {} })
    assert.deepEqual(reopened.latestRun(session.id), state)
    assert.deepEqual(reopened.get(session.id).events, sealed)
  }
})

test('projection replay respects reset and preserves a completed terminal snapshot', async () => {
  const sessions = new SessionRuntime(), session = sessions.create()
  const old = sessions.beginRun(session.id, {}, 'mock/demo')
  sessions.append(session.id, 'context/projection', { estimatedInputTokens: 1234, reservedOutputTokens: 10, safetyMarginTokens: 2048, removedTaskIds: ['old-task'] }, old)
  old.estimatedInputTokens = 1234; old.removedTaskIds = ['old-task']
  sessions.finishRun(old, 'completed')
  const completed = new SessionRuntime()
  await completed.restore({ read: async () => structuredClone(session.events), append: async () => {}, close: async () => {} })
  assert.deepEqual(completed.latestRun(session.id), old)
  sessions.clear(session.id)
  const run = sessions.beginRun(session.id, {}, 'mock/demo')
  sessions.append(session.id, 'context/projection', { estimatedInputTokens: 300, reservedOutputTokens: 10, safetyMarginTokens: 2048, removedTaskIds: [] }, run)
  const restored = new SessionRuntime()
  await restored.restore({ read: async () => structuredClone(session.events), append: async () => {}, close: async () => {} })
  assert.equal(restored.latestRun(session.id)?.estimatedInputTokens, 300)
  assert.deepEqual(restored.latestRun(session.id)?.removedTaskIds, [])
  assert.equal(restored.latestRun(session.id)?.runId, run.runId)
  assert.equal(restored.get(session.id).events.filter(e => e.type === 'context/projection').length, 2)
})
// NX-10 第三幕（demo:unknown）里确定性的那一半。演示中的崩溃是子进程被真杀掉，杀进程本身平台相关，
// 因此不进用例；但崩溃之后要走的每一步都是确定的，在这里钉住。
// 残局与演示一致：日志停在 tool/start（工具已经开始、结果没落盘），目录里留着 writer.lock（进程死时
// 没人释放；锁体就是 open 当时写下的形状，这里由用例直接放上）。
test('a stale writer lock blocks recovery until it is removed explicitly, then restore marks the interrupted tool unknown', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-stale-lock-'))
  const sessions = new SessionRuntime(), session = sessions.create({ workspace: root })
  const store = await JsonlStore.open(root, session.id)
  try {
    sessions.attachStore(session.id, store)
    const run = sessions.beginRun(session.id, {}, 'mock/demo')
    sessions.append(session.id, 'user/message', { content: 'mock task' }, run)
    sessions.append(session.id, 'assistant/tool_calls', { toolCalls: [{ id: 'wedged', name: 'bash', arguments: {} }] }, run)
    sessions.append(session.id, 'tool/start', { taskId: run.taskId, runId: run.runId, toolCallId: 'wedged', name: 'bash' }, run)
    // 工具真的已经跑过：它写下的副作用在恢复之后仍然在。
    await fs.writeFile(path.join(root, 'side-effect.txt'), 'already executed')
    await sessions.flush(session.id); await store.close()

    const lockPath = path.join(root, session.id, 'writer.lock')
    await fs.writeFile(lockPath, JSON.stringify({ token: 'stale-token', pid: 1 }))
    // Harness 不会替人判断锁是否陈旧，它只拒绝。
    await assert.rejects(JsonlStore.open(root, session.id), /session writer lock exists/)
    // 隔离尾部也要先抢同一把锁，所以它同样开不动——销掉锁是唯一路径，不是可选优化。
    await assert.rejects(JsonlStore.quarantineTail(root, session.id), /EEXIST/)

    await fs.unlink(lockPath)
    const reopened = await JsonlStore.open(root, session.id), restored = new SessionRuntime()
    const before = await reopened.read()
    await restored.restore(reopened, root)
    await restored.flush(session.id)
    const after = await reopened.read()

    assert.equal(await fs.readFile(path.join(root, 'side-effect.txt'), 'utf8'), 'already executed')
    assert.equal(restored.latestRun(session.id)?.status, 'error')
    // 恰好一条配对结果，且它是 unknown 而不是 skipped：这条调用有过 tool/start。
    assert.deepEqual(after.filter(e => e.type === 'tool/result').map(e => e.type === 'tool/result' ? [e.data.toolCallId, e.data.status] : []), [['wedged', 'unknown']])
    // 补出来的记录是真的追加到日志上的，不是内存里的重演。
    assert.ok(after.length > before.length)
    assert.ok(after.some(e => e.type === 'run/finish' && e.data.state.status === 'error'))
    // 副作用已经发生过，因此自动续跑必须被挡住——重试可能把它做第二遍。
    // beginRun 是同步抛出的：挡住续跑的判定发生在派发任何请求之前。
    assert.throws(() => restored.beginRun(session.id, {}, 'mock/demo', true), /unknown tool outcome/)
    await reopened.close()
  } finally { await store.close(); assert.equal(path.dirname(root), path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }) }
})
