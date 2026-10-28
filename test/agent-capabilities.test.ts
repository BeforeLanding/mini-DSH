import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHarness } from '../src/app/create-harness.js'
import { READ_ONLY_TOOLS } from '../src/core/agent-capabilities.js'
import { ToolRuntime } from '../src/core/tool-runtime.js'

test('child roles register only read tools, use distinct Harness state and never write result files into the workspace', async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'child-role-'))
  await fs.writeFile(path.join(workspace, 'entry.ts'), ('export const entry = true;'.repeat(4) + '\n').repeat(200))
  t.after(() => fs.rm(workspace, { recursive: true, force: true }))
  const parent = await createHarness({ workspace, profile: 'coding', autoApprove: true })
  try {
    for (const agentRole of ['analyst', 'test_designer', 'reviewer'] as const) {
      const child = await createHarness({ workspace, profile: 'coding', agentRole, autoApprove: true })
      const childTools = child.root.tools
      try {
        assert.notEqual(child.root.sessions, parent.root.sessions)
        assert.ok(child.capabilityManifest.tools.every(name => READ_ONLY_TOOLS.includes(name)))
        for (const name of ['write_file', 'edit_file', 'bash', 'task_report', 'task_changes', 'memory_propose', 'delegate_tasks']) assert.equal(child.root.tools.get(name), undefined)
        const identity = await child.root.systemPrompt.assemble({})
        assert.match(identity, /read-only/); assert.ok(!identity.includes('Query task_report before delivery'))
        const session = child.root.sessions.create({ workspace })
        const state = child.root.sessions.beginRun(session.id, {}, 'scripted/test')
        const result = await child.root.tools.execute('read_file', { path: 'entry.ts', maxLines: 200 }, { sessionId: session.id })
        assert.equal(result.isError, false, JSON.stringify(result))
        assert.deepEqual(await fs.readdir(workspace), ['entry.ts'])
        let mutations = 0
        child.root.tools.register({ name: 'write_file', origin: 'builtin', effect: 'write', execute() { mutations++; return 'bad' } })
        assert.equal((await child.root.tools.execute('write_file', { path: 'bad', content: 'bad' })).isError, true)
        assert.equal(mutations, 0); assert.ok(!child.root.tools.schemas().some(schema => schema.function.name === 'write_file'))
        child.root.sessions.finishRun(state, 'completed')
      } finally { await child.dispose() }
      assert.deepEqual(childTools.list(), [])
    }
    assert.ok(parent.root.tools.get('bash')); assert.ok(parent.root.tools.get('write_file'))
  } finally { await parent.dispose() }
})

test('capabilities cannot be widened and reject self-declared read effects and foreign origin before authorization', async () => {
  const tools = new ToolRuntime(), names = ['allowed']; let executed = 0, authorized = 0
  tools.setCapabilities(names); names.push('forbidden')
  tools.setAuthorization(async () => { authorized++ })
  tools.register({ name: 'forbidden', effect: 'read', origin: 'builtin', execute() { executed++ } })
  tools.register({ name: 'allowed', effect: 'read', origin: 'external', execute() { executed++ } })
  assert.equal((await tools.execute('forbidden')).isError, true)
  assert.equal((await tools.execute('allowed')).isError, true)
  assert.equal(executed, 0); assert.equal(authorized, 0)
  assert.throws(() => tools.setCapabilities(['forbidden']), /already fixed/)
})

test('read-only roles reject host misconfiguration before creating resources', async () => {
  const base = { workspace: process.cwd(), profile: 'coding' as const, agentRole: 'analyst' as const }
  await assert.rejects(createHarness({ ...base, commandRunner: async () => { throw new Error('not called') } }), /read-only roles/)
  await assert.rejects(createHarness({ ...base, memory: { mode: 'assist' } }), /read-only roles/)
  await assert.rejects(createHarness({ ...base, agentRole: 'swarm' as 'analyst' }), /invalid agent role/)
})
