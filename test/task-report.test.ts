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
import * as files from '../src/tools/files.js'
import * as bash from '../src/tools/bash.js'
import type { taskReport } from '../src/core/task-verification.js'

test('delivery report separates completed run, current coverage, unverified edits and all failed checks with independent pages', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'task-report-')), root = new Context()
  try {
    for (const plugin of [sessions, tools, systemPrompt]) await root.plugin(plugin)
    await root.plugin(sandbox, { workspace, autoApprove: true }); await root.plugin(files); await root.plugin(bash)
    const session = root.sessions.create({ workspace }), run = root.sessions.beginRun(session.id, {}, 'mock'), exec = { sessionId: session.id }
    const get = async (args = {}) => {
      const result = await root.tools.execute('task_report', args, exec)
      assert.equal(result.isError, false)
      return result.value as Awaited<ReturnType<typeof taskReport>>
    }
    assert.equal((await root.tools.execute('task_report')).isError, true)
    for (const args of [{ fileOffset: -1 }, { verificationOffset: 0.5 }, { maxRecords: 101 }]) assert.equal((await root.tools.execute('task_report', args, exec)).isError, true)
    for (const name of ['a', 'b']) assert.equal((await root.tools.execute('write_file', { path: name, content: 'initial', expectedHash: 'missing' }, exec)).isError, false)
    assert.equal((await get()).unverifiedFiles.length, 2)
    await fs.writeFile(path.join(workspace, 'config'), 'one')
    const verification = { files: ['a', 'config'] }
    await root.tools.execute('bash', { command: 'exit 3', verification }, exec)
    await root.tools.execute('bash', { command: 'printf ok', verification }, exec)
    root.sessions.finishRun(run, 'completed')
    let report = await get({ maxFiles: 1, maxRecords: 1 })
    assert.equal(report.runStatus, 'completed'); assert.equal(report.acceptance, 'not_asserted')
    assert.equal(report.files[0].verification, 'covered'); assert.equal(report.filesEof, false)
    assert.equal(report.checks[0].status, 'failed'); assert.equal(report.verificationsEof, false)
    assert.equal(report.verificationTotal, 2)
    report = await get({ fileOffset: 1, verificationOffset: 1, maxRecords: 1 })
    assert.deepEqual(report.unverifiedFiles, ['b']); assert.equal(report.checks[0].status, 'passed')
    assert.equal('stdout' in report.checks[0].commandResult!, false)
    await fs.writeFile(path.join(workspace, 'config'), 'two')
    assert.equal((await get()).files[0].verification, 'unverified')
    await fs.writeFile(path.join(workspace, 'config'), 'one')
    const next = root.sessions.beginRun(session.id, {}, 'mock')
    // A fresh task has no inherited evidence.
    assert.equal((await get()).verificationTotal, 0)
    root.sessions.finishRun(next, 'max_steps')
    root.sessions.beginRun(session.id, {}, 'mock', true)
    await root.tools.execute('write_file', { path: 'a', content: 'other' }, exec)
    await root.tools.execute('bash', { command: 'printf ok', verification }, exec)
    await root.tools.execute('edit_file', { path: 'a', oldText: 'other', newText: 'temporary' }, exec)
    await root.tools.execute('edit_file', { path: 'a', oldText: 'temporary', newText: 'other' }, exec)
    report = await get()
    assert.equal(report.checks[0].freshness, 'stale'); assert.equal(report.files[0].verification, 'unverified')
    const service = root.tools; await root.fiber.dispose(); assert.equal(service.get('task_report'), undefined)
  } finally { await root.fiber.dispose(); await fs.rm(workspace, { recursive: true, force: true }) }
})
