import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as tools from '../src/plugins/tools.js'
import * as systemPrompt from '../src/plugins/system-prompt.js'
import * as sandbox from '../src/plugins/sandbox.js'
import * as files from '../src/tools/files.js'
import { fingerprint } from '../src/core/file-edit.js'

test('file tools show precise approvals and refuse stale reads, approval changes and creation races', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'file-tools-')), file = path.join(directory, 'a')
  const root = new Context()
  try {
    await root.plugin(systemPrompt); await root.plugin(tools); await root.plugin(sandbox, { workspace: directory }); await root.plugin(files, { maxEditBytes: 100 })
    await fs.writeFile(file, 'user dirty\r\n中文😀\r\n')
    const read = root.tools.renderResult(await root.tools.execute('read_file', { path: 'a', maxLines: 1 }))
    assert.match(read, new RegExp(fingerprint('user dirty\r\n中文😀\r\n')))
    const approvals: string[] = []
    root.sandbox.setApprover(async request => { approvals.push(request.summary); return true })
    const good = await root.tools.execute('edit_file', { path: 'a', oldText: '中文', newText: '你好', expectedHash: fingerprint('user dirty\r\n中文😀\r\n') })
    assert.equal(good.isError, false); assert.match(approvals[0], /line 2/); assert.match(approvals[0], /-中文😀\r\n\+你好😀/)
    const stale = await root.tools.execute('write_file', { path: 'a', content: 'clobber', expectedHash: fingerprint('user dirty\r\n中文😀\r\n') })
    assert.equal(stale.isError, true); assert.equal(approvals.length, 1)
    root.sandbox.setApprover(async () => { await fs.writeFile(file, 'user changed'); return true })
    const conflict = await root.tools.execute('write_file', { path: 'a', content: 'agent' })
    assert.equal(conflict.isError, true); assert.match(root.tools.renderResult(conflict), /conflict/)
    assert.equal(await fs.readFile(file, 'utf8'), 'user changed')
    await fs.rm(file)
    const raced = await root.tools.execute('write_file', { path: 'a', content: 'agent', expectedHash: 'missing' })
    assert.equal(raced.isError, true); assert.equal(await fs.readFile(file, 'utf8'), 'user changed')
    root.sandbox.setApprover(async () => false)
    const denied = await root.tools.execute('edit_file', { path: 'a', oldText: 'user', newText: 'agent' })
    assert.equal(denied.isError, true); assert.equal(await fs.readFile(file, 'utf8'), 'user changed')
    assert.equal((await root.tools.execute('write_file', { path: '../escape', content: 'x' })).isError, true)
    assert.equal((await root.tools.execute('write_file', { path: 'a', content: 'x'.repeat(101) })).isError, true)
    assert.deepEqual(await fs.readdir(directory), ['a'])
  } finally { await root.fiber.dispose(); await fs.rm(directory, { recursive: true, force: true }) }
})

test('file tools reject cancellation and concurrent edits, and label large reads without a hash', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'file-tools-')), root = new Context()
  try {
    await root.plugin(systemPrompt); await root.plugin(tools); await root.plugin(sandbox, { workspace: directory }); const plugin = await root.plugin(files, { maxEditBytes: 10 })
    await fs.writeFile(path.join(directory, 'large'), 'x'.repeat(20))
    assert.match(root.tools.renderResult(await root.tools.execute('read_file', { path: 'large' })), /hash=unavailable/)
    let approve!: () => void, entered!: () => void
    const ready = new Promise<void>(resolve => { entered = resolve })
    root.sandbox.setApprover(async () => { entered(); await new Promise<void>(resolve => { approve = resolve }); return true })
    const controller = new AbortController()
    const pending = root.tools.execute('write_file', { path: 'a', content: 'x' }, { signal: controller.signal })
    await ready
    assert.equal((await root.tools.execute('write_file', { path: 'a', content: 'y' })).isError, true)
    controller.abort(); approve()
    assert.equal((await pending).isError, true)
    await assert.rejects(fs.access(path.join(directory, 'a')))
    await plugin.dispose(); assert.equal(root.tools.get('edit_file'), undefined)
  } finally { await root.fiber.dispose(); await fs.rm(directory, { recursive: true, force: true }) }
})
