import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as tools from '../src/plugins/tools.js'
import * as sandbox from '../src/plugins/sandbox.js'
import * as systemPrompt from '../src/plugins/system-prompt.js'
import * as bash from '../src/tools/bash.js'
import type { CommandResult } from '../src/core/command-runner.js'

async function boot(workspace: string, autoApprove = true) {
  const root = new Context()
  await root.plugin(tools); await root.plugin(systemPrompt)
  await root.plugin(sandbox, { workspace, autoApprove }); await root.plugin(bash)
  return root
}

test('Bash structured result retains failures, validates cwd and disposes', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'bash-cwd-'))
  const root = await boot(workspace)
  try {
    await fs.mkdir(path.join(workspace, 'nested'))
    const result = await root.tools.execute('bash', { command: 'printf out; printf err >&2; exit 7', cwd: 'nested' })
    assert.equal(result.isError, true)
    const value = result.value as CommandResult
    assert.equal(value.cwd, await fs.realpath(path.join(workspace, 'nested')))
    assert.equal(value.exitCode, 7); assert.equal(value.stdout.text, 'out'); assert.equal(value.stderr.text, 'err')
    assert.deepEqual(JSON.parse(root.tools.renderResult(result)), value)
    assert.equal((await root.tools.execute('bash', { command: 'pwd' })).isError, false)
    for (const cwd of ['..', 'missing', 123]) {
      const rejected = await root.tools.execute('bash', { command: 'touch marker', cwd })
      assert.equal(rejected.isError, true); assert.equal(rejected.value, null)
    }
    await fs.writeFile(path.join(workspace, 'file'), 'x')
    assert.match(root.tools.renderResult(await root.tools.execute('bash', { command: 'pwd', cwd: 'file' })), /directory/)
    await assert.rejects(fs.access(path.join(workspace, 'marker')))
    const service = root.tools
    await root.fiber.dispose(); assert.equal(service.get('bash'), undefined)
  } finally { await root.fiber.dispose(); await fs.rm(workspace, { recursive: true, force: true }) }
})

test('Bash approval shows cwd, rejects without execution and rechecks directory links', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'bash-approval-'))
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'bash-outside-'))
  const root = await boot(workspace, false)
  try {
    await fs.mkdir(path.join(workspace, 'one')); await fs.mkdir(path.join(workspace, 'two'))
    const link = path.join(workspace, 'alias')
    await fs.symlink(path.join(workspace, 'one'), link, process.platform === 'win32' ? 'junction' : 'dir')
    root.sandbox.setApprover(async request => {
      assert.ok(request.summary.includes(await fs.realpath(path.join(workspace, 'one'))))
      await fs.unlink(link); await fs.symlink(path.join(workspace, 'two'), link, process.platform === 'win32' ? 'junction' : 'dir')
      return true
    })
    const changed = await root.tools.execute('bash', { command: 'touch marker', cwd: 'alias' })
    assert.equal(changed.isError, true); assert.match(root.tools.renderResult(changed), /cwd changed/)
    await fs.unlink(link); await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    assert.match(root.tools.renderResult(await root.tools.execute('bash', { command: 'pwd', cwd: 'alias' })), /symlink/)
    root.sandbox.setApprover(async () => false)
    assert.equal((await root.tools.execute('bash', { command: 'touch marker' })).isError, true)
    await assert.rejects(fs.access(path.join(workspace, 'marker')))
    await assert.rejects(fs.access(path.join(workspace, 'two', 'marker')))
  } finally { await root.fiber.dispose(); await fs.rm(workspace, { recursive: true, force: true }); await fs.rm(outside, { recursive: true, force: true }) }
})
