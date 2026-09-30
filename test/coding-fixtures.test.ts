import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import { createFixture, fixtureIds } from '../scripts/coding-fixtures.js'
import type { ToolCall } from '../src/core/contracts.js'
import { assertToolProtocol } from '../src/core/context-runtime.js'
import * as sessions from '../src/plugins/session.js'
import * as systemPrompt from '../src/plugins/system-prompt.js'
import * as tools from '../src/plugins/tools.js'
import * as llm from '../src/plugins/llm.js'
import * as agents from '../src/plugins/agent.js'
import * as agentLoop from '../src/plugins/agent-loop.js'
import * as sandbox from '../src/plugins/sandbox.js'
import * as files from '../src/tools/files.js'
import * as bash from '../src/tools/bash.js'

const locationCases: Record<string, { token: string; source: string }> = {
  pagination: { token: 'NX05B-PAGE-LOCATE', source: 'src/page.mjs' },
}

for (const id of fixtureIds) {
  test(`coding fixture ${id}: initial failure, reference acceptance and fresh workspace`, async () => {
    const fixture = await createFixture(id), fresh = await createFixture(id)
    try {
      assert.notEqual(fixture.workspace, fresh.workspace)
      const location = locationCases[id]
      if (location) {
        const log = await fs.readFile(path.join(fixture.workspace, 'diagnostics/trace.log'), 'utf8')
        assert.ok(Buffer.byteLength(log) > 32 * 1024)
        assert.ok(log.split('\n').findIndex(line => line.includes(location.token)) >= 200)
        assert.match(log, new RegExp(`${location.token}: ${location.source.replaceAll('.', '\\.')}`))
      }
      const initial = await fixture.evaluate()
      assert.equal(initial.passed, false)
      assert.equal(initial.exitCode, 1, initial.output)
      assert.match(initial.output, /AssertionError/)
      await fixture.applyReference()
      const reference = await fixture.evaluate()
      assert.equal(reference.passed, true, reference.output)
      assert.equal((await fresh.evaluate()).passed, false)
    } finally { await fixture.close(); await fresh.close() }
    await assert.rejects(fs.access(fixture.workspace))
    await assert.rejects(fs.access(fresh.workspace))
  })

  test(`coding fixture ${id}: scripted model reads, edits and reruns real checks`, { timeout: 30_000 }, async () => {
    const fixture = await createFixture(id), root = new Context()
    try {
      for (const plugin of [sessions, systemPrompt, tools, llm, agents, agentLoop]) await root.plugin(plugin)
      await root.plugin(sandbox, { workspace: fixture.workspace, autoApprove: true })
      await root.plugin(files); await root.plugin(bash)
      const location = locationCases[id]
      const commands: ToolCall[] = location ? [
        { id: 'locate', name: 'grep', arguments: { path: 'diagnostics', query: location.token } },
        { id: 'inspect-log', name: 'read_file', arguments: { path: 'diagnostics/trace.log', startLine: 319, maxLines: 3 } },
      ] : []
      commands.push(...fixture.edits.map((edit, index) => ({ id: `read-${index}`, name: 'read_file', arguments: { path: edit.path } })))
      commands.push({ id: 'before', name: 'bash', arguments: { command: 'node check.mjs' } })
      if (id === 'options') {
        const edit = fixture.edits[0]
        const provisional = "export function joinWords(words, { separator = ', ' } = {}) {\n  return words.join(separator)\n}\n"
        commands.push({ id: 'partial-edit', name: 'edit_file', arguments: { ...edit, newText: provisional } })
        commands.push({ id: 'retry-fails', name: 'bash', arguments: { command: 'node check.mjs' } })
        commands.push({ id: 'correct-edit', name: 'edit_file', arguments: { ...edit, oldText: provisional } })
      } else for (const [index, edit] of fixture.edits.entries()) commands.push({ id: `edit-${index}`, name: 'edit_file', arguments: edit })
      commands.push({ id: 'after', name: 'bash', arguments: { command: 'node check.mjs' } })
      let step = 0
      const checks: boolean[] = []
      root.llm.register('scripted', { models: ['fixture'], chat: async ({ messages = [] }) => {
        assertToolProtocol(messages)
        const previous = commands[step - 1]
        if (previous) {
          const result = messages.at(-1)!
          assert.equal(result.role, 'tool')
          assert.equal(result.tool_call_id, previous.id)
          if (previous.name === 'bash') {
            const command = JSON.parse(result.content ?? '{}')
            assert.equal(command.exitCode, previous.id === 'after' ? 0 : 1)
            if (previous.id === 'after') assert.match(command.stdout.text, /public checks passed/)
          }
          else {
            assert.doesNotMatch(result.content ?? '', /ToolError:/)
            if (previous.id === 'locate' || previous.id === 'inspect-log') assert.match(result.content ?? '', new RegExp(location!.token))
          }
        }
        return step < commands.length ? { toolCalls: [commands[step++]] } : { content: 'scripted fixture finished' }
      } })
      const session = root.sessions.create({ source: 'coding-fixture', fixtureId: id })
      const agent = root.agents.create({ sessionId: session.id, model: 'scripted/fixture', loop: root.agentLoop,
        budget: { maxModelRequests: 16, maxToolCalls: 16, maxActiveDurationMs: 20_000 } })
      assert.equal(await agent.send(fixture.task, { onToolResult: result => { if (result.name === 'bash') checks.push(!result.isError) } }), 'scripted fixture finished')
      assert.deepEqual(checks, id === 'options' ? [false, false, true] : [false, true])
      assert.equal(root.sessions.latestRun(session.id)?.status, 'completed')
      const acceptance = await fixture.evaluate()
      assert.equal(acceptance.passed, true, acceptance.output)
      assert.equal(session.events.filter(e => e.type === 'tool/result').length, commands.length)
      assertToolProtocol(root.sessions.deriveMessages(session.id))
    } finally { await root.fiber.dispose(); await fixture.close() }
  })
}

test('independent acceptance rejects bypassed public checks, partial migration and early exit', async () => {
  const fixture = await createFixture('interface')
  try {
    const originalCheck = await fs.readFile(path.join(fixture.workspace, 'check.mjs'))
    await fs.writeFile(path.join(fixture.workspace, 'check.mjs'), "console.log('public checks passed')\n")
    const publicResult = spawnSync(process.execPath, ['check.mjs'], { cwd: fixture.workspace, encoding: 'utf8', timeout: 10_000, windowsHide: true })
    assert.equal(publicResult.status, 0)
    const tampered = await fixture.evaluate()
    assert.equal(tampered.passed, false)
    assert.deepEqual(tampered.protectedFilesChanged, ['check.mjs'])
    await fixture.applyReference()
    assert.equal((await fixture.evaluate()).passed, false)
    await fs.writeFile(path.join(fixture.workspace, 'check.mjs'), originalCheck)
    await fs.writeFile(path.join(fixture.workspace, 'src/receipt.mjs'), fixture.edits[1].oldText)
    assert.equal((await fixture.evaluate()).passed, false)
    await fs.writeFile(path.join(fixture.workspace, 'src/pricing.mjs'), 'process.exit(0)\n')
    const bypass = await fixture.evaluate()
    assert.equal(bypass.exitCode, 0)
    assert.equal(bypass.passed, false)
  } finally { await fixture.close() }
})

test('merge fixture requires both entry point and helper migration', async () => {
  const fixture = await createFixture('merge')
  try {
    for (const edit of fixture.edits) {
      await fs.writeFile(path.join(fixture.workspace, edit.path), edit.newText)
      assert.equal((await fixture.evaluate()).passed, false, `partial merge unexpectedly passed: ${edit.path}`)
      await fs.writeFile(path.join(fixture.workspace, edit.path), edit.oldText)
    }
    await fixture.applyReference()
    assert.equal((await fixture.evaluate()).passed, true)
  } finally { await fixture.close() }
})

test('independent acceptance protects nested diagnostic evidence', async () => {
  const fixture = await createFixture('boundary')
  try {
    const diagnostic = path.join(fixture.workspace, 'diagnostics/context.txt')
    await fixture.applyReference()
    assert.equal((await fixture.evaluate()).passed, true)
    await fs.writeFile(diagnostic, 'forged diagnostic\n')
    const result = await fixture.evaluate()
    assert.equal(result.passed, false)
    assert.deepEqual(result.protectedFilesChanged, ['diagnostics/context.txt'])
  } finally { await fixture.close() }
})

test('acceptance bounds hung code and output, rejects invalid limits and reports infrastructure failure', async () => {
  const fixture = await createFixture('boundary')
  try {
    await assert.rejects(fixture.evaluate({ timeoutMs: 0 }), /invalid acceptance limits/)
    await fs.writeFile(path.join(fixture.workspace, 'src/index.mjs'), 'while (true) {}\n')
    const hung = await fixture.evaluate({ timeoutMs: 200 })
    assert.equal(hung.passed, false)
    assert.equal(hung.exitCode, null)
    assert.match(hung.output, /ETIMEDOUT/)
    await fs.writeFile(path.join(fixture.workspace, 'src/index.mjs'), "process.stdout.write('x'.repeat(100000)); process.exit(0)\n")
    const noisy = await fixture.evaluate({ maxOutputBytes: 1024 })
    assert.equal(noisy.passed, false)
    assert.match(noisy.output, /ENOBUFS/)
    assert.ok(Buffer.byteLength(noisy.output) <= 1024)
  } finally { await fixture.close() }
})
