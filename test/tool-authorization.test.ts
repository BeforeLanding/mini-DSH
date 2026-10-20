import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as tools from '../src/plugins/tools.js'
import * as sandbox from '../src/plugins/sandbox.js'
import * as systemPrompt from '../src/plugins/system-prompt.js'

async function boot(autoApprove = false) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-policy-'))
  const root = new Context()
  await root.plugin(tools)
  await root.plugin(systemPrompt)
  await root.plugin(sandbox, { workspace, autoApprove })
  return { root, workspace, close: async () => { await root.fiber.dispose(); await fs.rm(workspace, { recursive: true, force: true }) } }
}

test('third-party write cannot execute without a specific approval, even under autoApprove', async () => {
  const h = await boot(true)
  let executions = 0
  try {
    h.root.tools.register({ name: 'external_write', origin: 'external', effect: 'write', resources: args => [args.path as string],
      execute() { executions++; return 'done' } })
    const args = { path: 'one.txt', content: 'first' }
    assert.equal((await h.root.tools.execute('external_write', args, { toolCallId: 'call-1' })).isError, true)
    assert.equal(executions, 0)
    const approvals: string[] = []
    h.root.sandbox.setApprover(async request => { approvals.push(request.summary); return true })
    assert.equal((await h.root.tools.execute('external_write', args, { toolCallId: 'call-1' })).isError, false)
    assert.equal(executions, 1)
    assert.match(approvals[0]!, /toolCallId=call-1; argsSha256=[0-9a-f]{64}/)
    assert.match(approvals[0]!, /policy=r02b-v1/)
    assert.equal((await h.root.tools.execute('external_write', { path: 'two.txt', content: 'changed' }, { toolCallId: 'call-2' })).isError, false)
    assert.equal(approvals.length, 2)
  } finally { await h.close() }
})

test('approval is bound to arguments, resolved resource and workspace', async () => {
  const h = await boot()
  let executions = 0
  try {
    h.root.tools.register({ name: 'external_write', resources: args => [args.path as string], execute() { executions++; return true } })
    const args = { path: 'before.txt' }
    h.root.sandbox.setApprover(async () => { args.path = 'after.txt'; return true })
    assert.equal((await h.root.tools.execute('external_write', args, { toolCallId: 'mutated' })).isError, true)
    assert.equal(executions, 0)
    const stable = { path: 'before.txt' }
    const service = h.root.get('sandbox') as unknown as { runtime: { workspace: string } }
    h.root.sandbox.setApprover(async () => { service.runtime.workspace = path.join(h.workspace, 'changed'); return true })
    assert.equal((await h.root.tools.execute('external_write', stable)).isError, true)
    assert.equal(executions, 0)
  } finally { await h.close() }
})
