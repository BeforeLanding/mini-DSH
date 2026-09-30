import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SessionRuntime } from '../src/core/session-runtime.js'
import { JsonlStore, parseLog, type EventStore } from '../src/core/event-store.js'
import { TaskVerification, verificationFiles, taskVerifications } from '../src/core/task-verification.js'
import type { CommandResult } from '../src/core/command-runner.js'
import type { SessionEvent } from '../src/core/contracts.js'

const signal = () => new AbortController().signal
const command = (cwd: string, exitCode = 0): CommandResult => ({ version: 1, type: 'command', command: 'check', cwd, status: 'exited', exitCode, signal: null, durationMs: 1, timedOut: false, cancelled: false, stdout: { text: 'ok', bytes: 2, truncated: false }, stderr: { text: '', bytes: 0, truncated: false } })

test('verification retains failure, detects changed versions, and restores unknown without execution across continuation/reset', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'verification-'))
  const sessions = new SessionRuntime(), session = sessions.create({ workspace: temp })
  let store: JsonlStore | undefined
  try {
    await fs.writeFile(path.join(temp, 'a'), 'one')
    store = await JsonlStore.open(path.join(temp, 'logs'), session.id); sessions.attachStore(session.id, store)
    const run = sessions.beginRun(session.id, {}, 'mock'), journal = new TaskVerification(sessions, session.id, run)
    const resolve = (file: string) => path.join(temp, file)
    const before = await verificationFiles(['a', 'missing'], resolve, 1024, signal())
    const first = await journal.start({ command: 'check', cwd: temp, files: before })
    await journal.finish(first, command(temp, 1), before)
    const second = await journal.start({ command: 'check', cwd: temp, files: before })
    await journal.finish(second, command(temp), before)
    let report = await taskVerifications(sessions, session.id, resolve, 1024, signal())
    assert.deepEqual(report.records.map(r => r.status), ['failed', 'passed'])
    assert.equal(report.records[1].freshness, 'current')
    await fs.writeFile(path.join(temp, 'a'), 'two')
    assert.equal((await taskVerifications(sessions, session.id, resolve, 1024, signal())).records[1].freshness, 'stale')
    const third = await journal.start({ command: 'check', cwd: temp, files: before })
    await journal.finish(third, command(temp), await verificationFiles(['a', 'missing'], resolve, 1024, signal()))
    await journal.start({ command: 'check', cwd: temp, files: before })
    sessions.finishRun(run, 'max_steps'); await sessions.flush(session.id); await sessions.close()
    const restored = new SessionRuntime(); store = await JsonlStore.open(path.join(temp, 'logs'), session.id)
    await restored.restore(store, temp)
    const continued = restored.beginRun(session.id, {}, 'mock', true)
    assert.equal(continued.taskId, run.taskId)
    report = await taskVerifications(restored, session.id, resolve, 1024, signal())
    assert.deepEqual(report.records.map(r => r.status), ['failed', 'passed', 'stale', 'unknown'])
    const page = await taskVerifications(restored, session.id, resolve, 1024, signal(), 1, 1)
    assert.equal(page.total, 4); assert.equal(page.nextOffset, 2); assert.equal(page.eof, false)
    assert.equal(await fs.readFile(path.join(temp, 'a'), 'utf8'), 'two')
    const unavailable = await taskVerifications(restored, session.id, () => { throw new Error('outside') }, 1024, signal())
    assert.equal(unavailable.records[1].freshness, 'unavailable')
    restored.finishRun(continued, 'completed'); await restored.flush(session.id); restored.clear(session.id)
    assert.equal((await taskVerifications(restored, session.id, resolve, 1024, signal())).total, 0)
    await restored.close()
  } finally { await store?.close(); await fs.rm(temp, { recursive: true, force: true }) }
})

test('verification rejects corrupt, duplicate and cross-scope JSONL and confirms intent before execution', async () => {
  const sessions = new SessionRuntime(), session = sessions.create(), run = sessions.beginRun(session.id, {}, 'mock')
  const journal = new TaskVerification(sessions, session.id, run)
  const files = [{ path: 'a', hash: 'missing' }]
  const id = await journal.start({ command: 'check', cwd: '.', files })
  await journal.finish(id, command('.'), files)
  const original = sessions.get(session.id).events
  const parse = (events: SessionEvent[]) => parseLog(events.map(e => JSON.stringify(e)).join('\n') + '\n', session.id)
  assert.equal(parse(original).length, original.length)
  for (const mutate of [
    (e: SessionEvent[]) => { const r = e.at(-1)!; r.runId = 'other' },
    (e: SessionEvent[]) => { const r = e.at(-1)!; if (r.type === 'verification/result') r.data.commandResult.command = 'other' },
    (e: SessionEvent[]) => { const r = e.at(-1)!; if (r.type === 'verification/result') r.data.files[0].path = '../outside' },
    (e: SessionEvent[]) => { const r = e.at(-1)!; if (r.type === 'verification/result') r.data.commandResult.exitCode = '0' as unknown as number },
    (e: SessionEvent[]) => { const r = structuredClone(e.at(-1)!); r.id = 'duplicate'; r.seq++; e.push(r) },
  ]) { const copy = structuredClone(original); mutate(copy); assert.throws(() => parse(copy)) }
  const failing = new SessionRuntime(), failedSession = failing.create(), failedRun = failing.beginRun(failedSession.id, {}, 'mock')
  const store: EventStore = { async append() { throw new Error('disk failure') }, async read() { return [] }, async close() {} }
  failing.attachStore(failedSession.id, store)
  await assert.rejects(new TaskVerification(failing, failedSession.id, failedRun).start({ command: 'check', cwd: '.', files }), /disk failure/)
  assert.equal(failing.confirmedEvents(failedSession.id).length, 0)
})
