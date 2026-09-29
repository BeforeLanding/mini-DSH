import type { Arguments } from '../src/core/contracts.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as sessions from '../src/plugins/session.js'
import * as systemPrompt from '../src/plugins/system-prompt.js'
import * as tools from '../src/plugins/tools.js'
import * as llm from '../src/plugins/llm.js'
import * as agents from '../src/plugins/agent.js'
import * as agentLoop from '../src/plugins/agent-loop.js'
import * as runtimeContext from '../src/plugins/runtime-context.js'
import * as sandbox from '../src/plugins/sandbox.js'
import * as bash from '../src/tools/bash.js'
import * as files from '../src/tools/files.js'
import * as externalPlugins from '../src/plugins/external-plugins.js'

test('the whole plugin stack boots on Cordis and runs a full model -> tool -> model turn', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-smoke-'))
  const root = new Context()
  try {
    for (const plugin of [sessions, systemPrompt, tools, llm, agents]) await root.plugin(plugin)
    await root.plugin(agentLoop, { budget: { maxModelRequests: 4 } })
    await root.plugin(runtimeContext, { workspace })
    await root.plugin(sandbox, { workspace, autoApprove: true })
    await root.plugin(bash, { workspace })
    const filePlugin = await root.plugin(files, { workspace })
    for (const service of ['sessions', 'systemPrompt', 'tools', 'llm', 'agents', 'agentLoop', 'sandbox'] as const) assert.ok(root[service])
    assert.deepEqual(root.tools.list().map(tool => tool.name).sort(), ['bash', 'edit_file', 'glob', 'grep', 'read_file', 'write_file'])
    const prompt = await root.systemPrompt.assemble({ step: 0 })
    assert.match(prompt, /You are a general-purpose agent/)
    assert.match(prompt, /## Runtime Context/)
    assert.match(prompt, /## Sandbox/)
    assert.ok(prompt.includes(workspace))
    let calls = 0
    root.llm.register('mock', {
      models: ['smoke'],
      async chat({ system = '', messages = [], tools: schemas = [] }) {
        calls++
        if (calls === 1) {
          assert.ok(schemas.some(tool => tool.function.name === 'bash'))
          assert.ok(system.includes('Runtime Context'))
          return { toolCalls: [{ id: 't1', name: 'bash', arguments: { command: 'pwd' } }] }
        }
        const last = messages.at(-1)
        assert.ok(last)
        assert.equal(last.role, 'tool')
        assert.match(last.content ?? '', /mini-dsh-smoke/)
        return { content: 'done', toolCalls: [] }
      },
    }, { defaultModel: 'smoke' })
    assert.equal(root.llm.defaultSelection(), 'mock/smoke')
    assert.deepEqual(root.llm.models(), ['mock/smoke'])
    const session = root.sessions.create({ source: 'smoke' })
    const agent = root.agents.create({ sessionId: session.id, model: 'mock/smoke', loop: root.agentLoop })
    assert.equal(await agent.send('print the working directory'), 'done')
    assert.equal(calls, 2)
    assert.equal(root.sessions.latestRun(session.id)?.policy.maxModelRequests, 4)
    assert.deepEqual(session.events.filter(event => ['session/start', 'user/message', 'assistant/tool_calls', 'tool/result', 'assistant/message'].includes(event.type)).map(event => event.type), ['session/start', 'user/message', 'assistant/tool_calls', 'tool/result', 'assistant/message'])

    const execute = async (name: string, args: Arguments) => {
      const result = await root.tools.execute(name, args)
      assert.equal(result.isError, false, root.tools.renderResult(result))
      return result.value as string
    }
    await execute('write_file', { path: 'nested/a.txt', content: 'hello world\nhello again' })
    await execute('edit_file', { path: 'nested/a.txt', oldText: 'world', newText: 'Harness' })
    assert.match(await execute('read_file', { path: 'nested/a.txt' }), /hello Harness/)
    assert.deepEqual(await execute('glob', { pattern: '**/*.txt' }), ['nested/a.txt'])
    assert.match(await execute('grep', { query: 'Harness' }), /nested\/a.txt:1:hello Harness/)
    const ambiguous = await root.tools.execute('edit_file', {path: 'nested/a.txt', oldText: 'hello', newText: 'hi'})
    assert.equal(ambiguous.isError, true)
    assert.match(root.tools.renderResult(ambiguous), /oldText is not unique/)
    const escape = await root.tools.execute('write_file', {path: '../escape.txt', content: 'bad'})
    assert.equal(escape.isError, true)
    assert.match(root.tools.renderResult(escape), /path escapes/)
    const blocked = await root.tools.execute('bash', {command: 'rm -rf src'})
    assert.equal(blocked.isError, true)
    assert.match(root.tools.renderResult(blocked), /recursive delete/)
    await filePlugin.dispose()
    assert.deepEqual(root.tools.list().map(tool => tool.name), ['bash'])
  } finally {
    await root.fiber.dispose()
    // Only remove the exact directory created by this test under os.tmpdir().
    assert.ok(path.dirname(workspace) === path.resolve(os.tmpdir()))
    await fs.rm(workspace, { recursive: true, force: true })
  }
})

test('external plugin loader tolerates an optional failure and enforces a required one', async () => {
  const root = new Context()
  const originalLog = console.log
  const originalError = console.error
  const entries = [{ package: 'mini-dsh-definitely-not-installed', required: false }]
  console.log = () => {}
  console.error = () => {}
  try {
    await root.plugin(externalPlugins, { entries })
    await assert.rejects(async () => {
      await root.plugin(externalPlugins, { entries: [{ ...entries[0], required: true }] })
    }, /mini-dsh-definitely-not-installed/)
  } finally {
    console.log = originalLog
    console.error = originalError
    await root.fiber.dispose()
  }
})
