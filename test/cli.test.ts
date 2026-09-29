import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
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
import * as sandbox from '../src/plugins/sandbox.js'
import * as cli from '../src/plugins/cli.js'
import { JsonlStore } from '../src/core/event-store.js'
async function boot(workspace: string, directory: string, resumeSessionId?: string) {
  const root = new Context(), input = new PassThrough(), output = new PassThrough()
  let text = '', models = 0, executions = 0
  output.on('data', chunk => { text += String(chunk) })
  for (const plugin of [sessions, systemPrompt, tools, llm, agents, agentLoop]) await root.plugin(plugin)
  await root.plugin(sandbox, { workspace, autoApprove: true })
  root.llm.register('mock', { models: ['test', 'alternate'], capabilities: { test: { contextWindowTokens: 1_000_000 }, alternate: { contextWindowTokens: 1_000_000 } },
    chat: async () => ++models === 1 ? { toolCalls: [{ id: 'a', name: 'tick', arguments: {} }] } : { content: 'done' } })
  root.tools.register({ name: 'tick', execute: () => { executions++; return 'ok' } })
  await root.plugin(cli, { input, output, sessionDirectory: directory, resumeSessionId, ...(resumeSessionId ? {} : { budget: { maxModelRequests: 1 } }) })
  async function waitFor(pattern: string) {
    if (text.includes(pattern)) return
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { output.off('data', check); reject(new Error(`missing CLI output ${pattern}: ${text}`)) }, 5000)
      const check = () => { if (text.includes(pattern)) { clearTimeout(timer); output.off('data', check); resolve() } }
      output.on('data', check)
    })
  }
  return { root, input, output, waitFor, text: () => text, models: () => models, executions: () => executions }
}
test('CLI reports budgets, continues, persists settings and resumes/reset without replay', { timeout: 15000 }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-cli-')), workspace = path.join(temp, 'workspace'), directory = path.join(temp, 'sessions')
  await fs.mkdir(workspace)
  let first: Awaited<ReturnType<typeof boot>> | undefined, second: Awaited<ReturnType<typeof boot>> | undefined
  try {
    first = await boot(workspace, directory)
    const id = first.root.sessions.list()[0].id
    first.input.write('mock task\n/budget\n/continue\n/model mock/alternate\n/budget {"maxModelRequests":0}\n')
    await first.waitFor('Model: mock/alternate')
    await first.waitFor('"maxModelRequests": 0')
    assert.match(first.text(), /stopped: max_steps/)
    assert.match(first.text(), /\[Task\] runs=2/)
    assert.match(first.text(), /estimated/)
    assert.equal(first.models(), 2)
    assert.equal(first.executions(), 0)
    first.input.write('/exit\n'); await first.root.fiber.dispose()
    const disk = await JsonlStore.open(directory, id)
    const original = await disk.read(); await disk.close()
    second = await boot(workspace, directory, id)
    assert.match(second.text(), /Model: mock\/alternate/)
    assert.equal(second.root.agents.list()[0].budget?.maxModelRequests, 0)
    second.input.write('/continue\n/reset\nmock new task\n/budget\n')
    await second.waitFor('Session reset:')
    await second.waitFor('[Run max_steps]')
    assert.match(second.text(), /task already completed/)
    assert.equal(second.models(), 0)
    assert.equal(second.executions(), 0)
    assert.equal(second.root.sessions.get(id).events.filter(e => e.type === 'session/reset').length, 1)
    assert.ok(second.root.sessions.get(id).events.length > original.length)
    assert.equal(second.root.sessions.deriveMessages(id)[0].content, 'mock new task')
    second.input.write('/exit\n'); await second.root.fiber.dispose()
    assert.equal(second.input.listenerCount('data'), 0)
    await assert.rejects(fs.access(path.join(directory, id, 'writer.lock')))
  } finally {
    await first?.root.fiber.dispose(); await second?.root.fiber.dispose()
    assert.equal(path.dirname(temp), path.resolve(os.tmpdir())); await fs.rm(temp, { recursive: true, force: true })
  }
})
test('CLI rejects invalid overrides without changing the effective policy', { timeout: 10000 }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-cli-invalid-'))
  const app = await boot(temp, path.join(temp, 'sessions'))
  try {
    app.input.write('/budget {"maxModelRequests":-1}\n/budget\n')
    await app.waitFor('invalid budget maxModelRequests')
    await app.waitFor('"maxModelRequests": 1')
    assert.equal(app.models(), 0)
  } finally {
    await app.root.fiber.dispose(); assert.equal(path.dirname(temp), path.resolve(os.tmpdir())); await fs.rm(temp, { recursive: true, force: true })
  }
})
