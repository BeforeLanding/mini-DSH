import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as tools from '../src/plugins/tools.js'
import * as sandbox from '../src/plugins/sandbox.js'
import * as systemPrompt from '../src/plugins/system-prompt.js'
import * as sessions from '../src/plugins/session.js'
import * as bash from '../src/tools/bash.js'
import { taskVerifications } from '../src/core/task-verification.js'
import { parseLog, type EventStore } from '../src/core/event-store.js'
import type { SessionEvent } from '../src/core/contracts.js'

async function boot(workspace: string, config: Parameters<typeof bash.apply>[1] = {}) {
  const root = new Context()
  for (const plugin of [sessions, tools, systemPrompt]) await root.plugin(plugin)
  await root.plugin(sandbox, { workspace, autoApprove: false }); await root.plugin(bash, config)
  root.sandbox.setApprover(async () => true)
  const session = root.sessions.create({ workspace }), run = root.sessions.beginRun(session.id, {}, 'mock')
  return { root, session, run, exec: { sessionId: session.id, toolCallId: 'check-call' }, report: () => taskVerifications(root.sessions, session.id, file => root.sandbox.resolvePath(file), 1024, new AbortController().signal) }
}

test('Bash explicitly records approved checks, preserves failure, detects check mutation and leaves ordinary commands unverified', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'bash-verification-'))
  const { root, session, exec, report } = await boot(workspace)
  try {
    await fs.writeFile(path.join(workspace, 'a'), 'old'); await fs.mkdir(path.join(workspace, 'sub'))
    assert.equal((await root.tools.execute('bash', { command: 'printf normal' }, exec)).isError, false)
    assert.equal((await report()).total, 0)
    root.sandbox.setApprover(async request => { assert.match(request.summary, /verification files.*a/); await fs.writeFile(path.join(workspace, 'a'), 'approved'); return true })
    assert.equal((await root.tools.execute('bash', { command: 'printf checked', cwd: 'sub', verification: { files: ['a'] } }, exec)).isError, false)
    root.sandbox.setApprover(async () => true)
    assert.equal((await root.tools.execute('bash', { command: 'printf failure >&2; exit 9', verification: { files: ['a'] } }, exec)).isError, true)
    assert.equal((await root.tools.execute('bash', { command: 'printf changed > a', verification: { files: ['a'] } }, exec)).isError, false)
    const records = (await report()).records
    assert.deepEqual(records.map(r => r.status), ['passed', 'failed', 'stale'])
    assert.equal(records[0].freshness, 'stale'); assert.equal(records[0].toolCallId, 'check-call')
    assert.equal(records[1].commandResult?.stderr.text, 'failure'); assert.equal(records[1].commandResult?.exitCode, 9)
    const events = root.sessions.get(session.id).events
    assert.deepEqual(parseLog(events.map(e => JSON.stringify(e)).join('\n') + '\n', session.id), events)
  } finally { await root.fiber.dispose(); await fs.rm(workspace, { recursive: true, force: true }) }
})

test('verification rejects invalid scopes, limits and approval and cannot execute before durable intent', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'bash-verification-errors-'))
  const { root, session, exec, report } = await boot(workspace, { maxVerificationFiles: 2, maxVerificationFileBytes: 4 })
  try {
    await fs.writeFile(path.join(workspace, 'large'), '12345')
    for (const files of [[], ['../escape'], ['a', 'a'], ['a', 'b', 'c'], ['large'], [123], ['a\\b']]) {
      const result = await root.tools.execute('bash', { command: 'touch marker', verification: { files } }, exec)
      assert.equal(result.isError, true)
    }
    assert.equal((await root.tools.execute('bash', { command: 'touch marker', verification: { files: ['a'] } })).isError, true)
    root.sandbox.setApprover(async () => false)
    assert.equal((await root.tools.execute('bash', { command: 'touch marker', verification: { files: ['a'] } }, exec)).isError, true)
    assert.equal((await report()).total, 0)
    root.sandbox.setApprover(async () => true)
    const store: EventStore = { async append(event) { if (event.type === 'verification/start') throw new Error('intent write failure') }, async read() { return [] }, async close() {} }
    root.sessions.attachStore(session.id, store)
    assert.equal((await root.tools.execute('bash', { command: 'touch marker', verification: { files: ['a'] } }, exec)).isError, true)
    await assert.rejects(fs.access(path.join(workspace, 'marker')))
    assert.equal((await report()).total, 0)
  } finally { await root.fiber.dispose(); await fs.rm(workspace, { recursive: true, force: true }) }
})

test('timeout and cancellation record real command outcomes while failed result persistence remains unknown', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'bash-verification-cancel-'))
  const { root, session, exec, report } = await boot(workspace, { timeoutMs: 800 })
  try {
    const timed = await root.tools.execute('bash', { command: 'printf partial; sleep 4', verification: { files: ['a'] } }, exec)
    assert.equal(timed.isError, true)
    assert.equal((await report()).records[0].commandResult?.status, 'timed_out')
    const controller = new AbortController()
    const pending = root.tools.execute('bash', { command: 'printf partial; sleep 4', verification: { files: ['a'] } }, { ...exec, signal: controller.signal })
    setTimeout(() => controller.abort(), 350)
    assert.equal((await pending).isError, true)
    assert.equal((await report()).records[1].commandResult?.status, 'cancelled')
    const persisted: SessionEvent[] = []
    const store: EventStore = { async append(event) { if (event.type === 'verification/result') throw new Error('result write failure'); persisted.push(event) }, async read() { return persisted }, async close() {} }
    // Attach to a fresh session so earlier result events can be persisted normally.
    const next = root.sessions.create({ workspace }); root.sessions.beginRun(next.id, {}, 'mock'); root.sessions.attachStore(next.id, store)
    const failure = await root.tools.execute('bash', { command: 'touch executed', verification: { files: ['a'] } }, { sessionId: next.id })
    assert.equal(failure.isError, true); await fs.access(path.join(workspace, 'executed'))
    assert.equal((await taskVerifications(root.sessions, next.id, file => root.sandbox.resolvePath(file), 1024, new AbortController().signal)).records[0].status, 'unknown')
  } finally { await root.fiber.dispose(); await fs.rm(workspace, { recursive: true, force: true }) }
})

test('verification rechecks cwd after durable intent and refuses a directory alias swapped during persistence', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'verification-cwd-'))
  const { root, session, exec, report } = await boot(workspace)
  try {
    await fs.mkdir(path.join(workspace, 'one')); await fs.mkdir(path.join(workspace, 'two'))
    const alias = path.join(workspace, 'alias')
    await fs.symlink(path.join(workspace, 'one'), alias, process.platform === 'win32' ? 'junction' : 'dir')
    const store: EventStore = { async append(event) {
      if (event.type === 'verification/start') {
        await fs.unlink(alias)
        await fs.symlink(path.join(workspace, 'two'), alias, process.platform === 'win32' ? 'junction' : 'dir')
      }
    }, async read() { return [] }, async close() {} }
    root.sessions.attachStore(session.id, store)
    const result = await root.tools.execute('bash', { command: 'touch marker', cwd: 'alias', verification: { files: ['a'] } }, exec)
    assert.equal(result.isError, true); assert.match(root.tools.renderResult(result), /cwd changed before/)
    await assert.rejects(fs.access(path.join(workspace, 'one', 'marker')))
    await assert.rejects(fs.access(path.join(workspace, 'two', 'marker')))
    assert.equal((await report()).records[0].status, 'unknown')
  } finally { await root.fiber.dispose(); await fs.rm(workspace, { recursive: true, force: true }) }
})
