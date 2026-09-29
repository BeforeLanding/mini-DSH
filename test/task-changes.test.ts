import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as sessions from '../src/plugins/session.js'
import * as systemPrompt from '../src/plugins/system-prompt.js'
import * as tools from '../src/plugins/tools.js'
import * as sandbox from '../src/plugins/sandbox.js'
import * as files from '../src/tools/files.js'
import { JsonlStore, parseLog, type EventStore } from '../src/core/event-store.js'
import { fingerprint } from '../src/core/file-edit.js'
import { TaskChanges, taskChanges } from '../src/core/task-changes.js'
import { SessionRuntime } from '../src/core/session-runtime.js'
import type { SessionEvent } from '../src/core/contracts.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

async function boot(workspace: string, autoApprove = true, maxTrackedFiles = 100) {
  const root = new Context()
  for (const plugin of [sessions, systemPrompt, tools]) await root.plugin(plugin)
  await root.plugin(sandbox, { workspace, autoApprove }); await root.plugin(files, { maxTrackedFiles })
  return root
}

test('task journal preserves dirty baseline, rejects stale reads, and resumes across JSONL restart without attributing user edits', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'task-changes-')), workspace = path.join(temp, 'work')
  await fs.mkdir(workspace)
  const roots: Context[] = [], stores: JsonlStore[] = []
  try {
    const git = promisify(execFile)
    await git('git', ['init', '--quiet'], { cwd: workspace, windowsHide: true })
    await fs.writeFile(path.join(workspace, 'a'), 'staged\r\nvalue=1\r\n')
    await git('git', ['add', 'a'], { cwd: workspace, windowsHide: true })
    await fs.writeFile(path.join(workspace, 'a'), 'user dirty\r\nvalue=1\r\n')
    const first = await boot(workspace); roots.push(first)
    const session = first.sessions.create({ workspace }), store = await JsonlStore.open(path.join(temp, 'logs'), session.id); stores.push(store)
    first.sessions.attachStore(session.id, store)
    const run = first.sessions.beginRun(session.id, {}, 'mock')
    const exec = { sessionId: session.id }
    assert.equal((await first.tools.execute('read_file', { path: 'a' }, exec)).isError, false)
    await fs.writeFile(path.join(workspace, 'a'), 'user newer\r\nvalue=1\r\n')
    const stale = await first.tools.execute('edit_file', { path: 'a', oldText: 'value=1', newText: 'value=2' }, exec)
    assert.equal(stale.isError, true); assert.match(first.tools.renderResult(stale), /conflict/)
    assert.equal((await first.tools.execute('read_file', { path: 'a' }, exec)).isError, false)
    assert.equal((await first.tools.execute('edit_file', { path: 'a', oldText: 'value=1', newText: 'value=2' }, exec)).isError, false)
    assert.equal((await first.tools.execute('write_file', { path: 'new', content: 'created', expectedHash: 'missing' }, exec)).isError, false)
    assert.equal((await first.tools.execute('edit_file', { path: 'a', oldText: 'absent', newText: '' }, exec)).isError, true)
    const report = await taskChanges(first.sessions, session.id, file => first.sandbox.resolvePath(file), 1024, new AbortController().signal)
    assert.equal(report.files.length, 2)
    assert.equal(report.files[0].beforeHash, fingerprint('user dirty\r\nvalue=1\r\n'))
    assert.equal(report.files[0].diffBasis, 'individual_edits')
    assert.equal(report.files[0].externalChangesBetweenEdits, true)
    assert.doesNotMatch(report.files[0].diff!, /user dirty|user newer/)
    assert.match(report.files[0].diff!, /-value=1\r\n\+value=2/)
    assert.deepEqual(report.files[0].attempts.map(attempt => attempt.status), ['failed', 'applied', 'failed'])
    assert.match((await git('git', ['diff', '--', 'a'], { cwd: workspace, windowsHide: true })).stdout, /user newer/)
    first.sessions.finishRun(run, 'max_steps'); await first.sessions.flush(session.id)
    const stat = await fs.stat(path.join(workspace, 'a'))
    await first.sessions.close(); await first.fiber.dispose()
    const second = await boot(workspace); roots.push(second)
    const reopened = await JsonlStore.open(path.join(temp, 'logs'), session.id); stores.push(reopened)
    await second.sessions.restore(reopened, workspace)
    const continued = second.sessions.beginRun(session.id, {}, 'mock', true)
    assert.equal(continued.taskId, run.taskId)
    assert.equal((await fs.stat(path.join(workspace, 'a'))).mtimeMs, stat.mtimeMs)
    assert.equal((await second.tools.execute('edit_file', { path: 'a', oldText: 'value=2', newText: 'value=3' }, exec)).isError, false)
    await fs.writeFile(path.join(workspace, 'new'), 'external')
    const paged = await taskChanges(second.sessions, session.id, file => second.sandbox.resolvePath(file), 1024, new AbortController().signal, true, 1, 1)
    assert.equal(paged.files[0].externalChange, true); assert.equal(paged.nextOffset, 2); assert.equal(paged.eof, true)
    second.sessions.finishRun(continued, 'completed'); await second.sessions.flush(session.id)
    assert.deepEqual(await reopened.read(), second.sessions.get(session.id).events)
    second.sessions.clear(session.id)
    assert.equal((await taskChanges(second.sessions, session.id, file => second.sandbox.resolvePath(file), 1024, new AbortController().signal)).files.length, 0)
    await second.sessions.close()
  } finally {
    for (const root of roots) await root.fiber.dispose()
    for (const store of stores) await store.close()
    await fs.rm(temp, { recursive: true, force: true })
  }
})

test('unknown edits survive recovery without replay and corrupted snapshots/results are rejected', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'task-unknown-'))
  const first = new SessionRuntime(), session = first.create({ workspace: temp }), run = first.beginRun(session.id, {}, 'mock')
  const journal = new TaskChanges(first, session.id, run)
  try {
    await journal.observe('a', { text: null, hash: 'missing' })
    await journal.start({ path: 'a', tool: 'write_file', before: { text: null, hash: 'missing' }, after: { text: 'maybe written', hash: fingerprint('maybe written') } })
    await fs.writeFile(path.join(temp, 'a'), 'maybe written')
    const copy = structuredClone(session.events)
    const recovered = new SessionRuntime()
    await recovered.restore({ read: async () => copy, append: async () => {}, close: async () => {} }, temp)
    const report = await taskChanges(recovered, session.id, file => path.join(temp, file), 1024, new AbortController().signal)
    assert.equal(report.files[0].status, 'unknown'); assert.equal(report.files[0].diff, '')
    assert.throws(() => recovered.beginRun(session.id, {}, 'mock', true), /unknown file edit/)
    const corrupted = structuredClone(copy)
    const baseline = corrupted.find(event => event.type === 'file/baseline')!
    if (baseline.type === 'file/baseline') baseline.data.snapshot.hash = 'wrong'
    assert.throws(() => parseLog(corrupted.map(event => JSON.stringify(event) + '\n').join(''), session.id), /invalid event payload/)
    const invalid = first.append(session.id, 'file/change-result', { changeId: 'nonexistent', status: 'failed' }, run)
    assert.throws(() => parseLog([...copy, invalid].map(event => JSON.stringify(event) + '\n').join(''), session.id), /missing\/duplicate/)
  } finally { await fs.rm(temp, { recursive: true, force: true }) }
})

test('durable intent blocks side effects on storage failure; result failure stays unknown rather than successful', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'task-store-fail-'))
  try {
    for (const failure of ['file/change', 'file/change-result']) {
      const root = await boot(temp), session = root.sessions.create({ workspace: temp })
      const saved: SessionEvent[] = []
      const store: EventStore = { read: async () => saved, close: async () => {}, append: async event => { if (event.type === failure) throw new Error('injected storage failure'); saved.push(event) } }
      root.sessions.attachStore(session.id, store)
      root.sessions.beginRun(session.id, {}, 'mock')
      const result = await root.tools.execute('write_file', { path: failure, content: 'agent' }, { sessionId: session.id })
      assert.equal(result.isError, true)
      if (failure === 'file/change') await assert.rejects(fs.access(path.join(temp, failure)))
      else {
        assert.equal(await fs.readFile(path.join(temp, failure), 'utf8'), 'agent')
        const report = await taskChanges(root.sessions, session.id, file => path.join(temp, file), 1024, new AbortController().signal)
        assert.equal(report.files[0].status, 'unknown'); assert.equal(report.files[0].diff, '')
        assert.match(root.tools.renderResult(result), /persistence is uncertain/)
      }
      await root.sessions.close(); await root.fiber.dispose()
    }
  } finally { await fs.rm(temp, { recursive: true, force: true }) }
})

test('tracked cancellation records a failed attempt even after run termination and enforces file limits', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'task-cancel-')), root = await boot(temp, false, 1)
  try {
    const session = root.sessions.create({ workspace: temp }), run = root.sessions.beginRun(session.id, {}, 'mock')
    let entered!: () => void, release!: () => void
    const ready = new Promise<void>(resolve => { entered = resolve })
    root.sandbox.setApprover(async () => { entered(); await new Promise<void>(resolve => { release = resolve }); return true })
    const controller = new AbortController()
    const pending = root.tools.execute('write_file', { path: 'a', content: 'x' }, { sessionId: session.id, signal: controller.signal })
    await ready
    await assert.rejects(new TaskChanges(root.sessions, session.id, run, 1).observe('b', { text: null, hash: 'missing' }), /tracked file limit/)
    controller.abort(); root.sessions.finishRun(run, 'cancelled'); release()
    assert.equal((await pending).isError, true)
    await assert.rejects(fs.access(path.join(temp, 'a')))
    const report = await taskChanges(root.sessions, session.id, file => path.join(temp, file), 1024, new AbortController().signal)
    assert.equal(report.files[0].status, 'failed')
    assert.doesNotThrow(() => parseLog(session.events.map(event => JSON.stringify(event) + '\n').join(''), session.id))
  } finally { await root.fiber.dispose(); await fs.rm(temp, { recursive: true, force: true }) }
})
