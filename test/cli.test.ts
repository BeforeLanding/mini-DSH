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
import * as files from '../src/tools/files.js'
import { fingerprint } from '../src/core/file-edit.js'
import * as bash from '../src/tools/bash.js'
async function boot(workspace: string, directory: string, resumeSessionId?: string, autoApprove = true, maxChangeOutputBytes?: number) {
  const root = new Context(), input = new PassThrough(), output = new PassThrough()
  let text = '', models = 0, executions = 0
  output.on('data', chunk => { text += String(chunk) })
  for (const plugin of [sessions, systemPrompt, tools, llm, agents, agentLoop]) await root.plugin(plugin)
  await root.plugin(sandbox, { workspace, autoApprove })
  root.llm.register('mock', { models: ['test', 'alternate'], capabilities: { test: { contextWindowTokens: 1_000_000 }, alternate: { contextWindowTokens: 1_000_000 } },
    chat: async () => ++models === 1 ? { toolCalls: [{ id: 'a', name: 'tick', arguments: {} }] } : { content: 'done' } })
  root.tools.register({ name: 'tick', execute: () => { executions++; return 'ok' } })
  await root.plugin(cli, { input, output, sessionDirectory: directory, resumeSessionId, maxChangeOutputBytes, ...(resumeSessionId ? {} : { budget: { maxModelRequests: 1 } }) })
  async function waitFor(pattern: string, timeoutMs = 5000) {
    if (text.includes(pattern)) return
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { output.off('data', check); reject(new Error(`missing CLI output ${pattern}: ${text}`)) }, timeoutMs)
      const check = () => { if (text.includes(pattern)) { clearTimeout(timer); output.off('data', check); resolve() } }
      output.on('data', check)
    })
  }
  return { root, input, output, waitFor, text: () => text, models: () => models, executions: () => executions }
}

test('CLI and scripted model deliver versioned verification, restore reports without replay and expose byte pagination', { timeout: 45000 }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-report-')), directory = path.join(temp, 'logs')
  const app = await boot(temp, directory)
  let restored: Awaited<ReturnType<typeof boot>> | undefined
  try {
    await app.root.plugin(files); await app.root.plugin(bash)
    const calls = [
      { id: 'create', name: 'write_file', arguments: { path: 'a', content: '中文😀', expectedHash: 'missing' } },
      { id: 'fail', name: 'bash', arguments: { command: 'exit 7', verification: { files: ['a'] } } },
      { id: 'pass', name: 'bash', arguments: { command: 'printf ok', verification: { files: ['a'] } } },
      { id: 'report', name: 'task_report', arguments: {} },
    ]
    let step = 0
    app.root.llm.register('delivery', { models: ['test'], capabilities: { test: { contextWindowTokens: 1_000_000 } }, chat: async ({ messages = [] }) => {
      if (step === calls.length) {
        const report = JSON.parse(messages.at(-1)!.content!)
        assert.equal(report.files[0].verification, 'covered')
        assert.deepEqual(report.checks.map((check: { status: string }) => check.status), ['failed', 'passed'])
        return { content: '交付：检查失败与成功均保留；未断言任务验收。' }
      }
      return { toolCalls: [calls[step++]] }
    } })
    app.input.write('/model delivery/test\n/budget {"maxModelRequests":10}\n模拟验证任务\n')
    await app.waitFor('[Check] passed version=current', 15000)
    assert.match(app.text(), /\[Run completed\]/); assert.match(app.text(), /\[Check\] failed version=current/)
    assert.match(app.text(), /task acceptance not asserted/)
    const id = app.root.sessions.list()[0].id
    app.input.write('/model mock/test\n'); await app.waitFor('Model: mock/test')
    app.input.write('/exit\n'); await app.root.fiber.dispose()
    restored = await boot(temp, directory, id, true, 256); await restored.root.plugin(files)
    restored.input.write('/report\n')
    await restored.waitFor('report truncated; continue: /report')
    const hint = /report truncated; continue: \/report (\d+) (\d+) (\d+)/.exec(restored.text())!
    restored.input.write(`/report ${hint[1]} ${hint[2]} ${hint[3]}\n/report -1\n/report 0 0 999999\n`)
    await restored.waitFor('byteOffset must be within the report')
    restored.input.write('/trace\n')
    await restored.waitFor('trace truncated; continue: /trace')
    const traceHint = /trace truncated; continue: \/trace (\d+) (\d+)/.exec(restored.text())!
    restored.input.write(`/trace ${traceHint[1]} ${traceHint[2]}\n/trace -1\n/trace 0 999999\n`)
    await restored.waitFor('byteOffset must be within the trace')
    assert.equal(restored.models(), 0); assert.equal(await fs.readFile(path.join(temp, 'a'), 'utf8'), '中文😀')
    assert.match(restored.text(), /offset must be a nonnegative safe integer/)
    restored.input.write('/reset\n/report\n')
    await restored.waitFor('task=none run=none')
  } finally { await app.root.fiber.dispose(); await restored?.root.fiber.dispose(); await fs.rm(temp, { recursive: true, force: true }) }
})
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

test('CLI and scripted model deliver confirmed task changes, failed attempts and UTF-8 diff pagination', { timeout: 15000 }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-cli-changes-')), workspace = path.join(temp, 'work')
  await fs.mkdir(workspace)
  const original = '用户已有\r\nvalue=1\r\n'
  await fs.writeFile(path.join(workspace, 'a'), original)
  const app = await boot(workspace, path.join(temp, 'logs'), undefined, true, 256)
  try {
    await app.root.plugin(files, { maxTrackedFiles: 2 })
    const commands = [
      { id: 'read', name: 'read_file', arguments: { path: 'a' } },
      { id: 'edit', name: 'edit_file', arguments: { path: 'a', oldText: 'value=1', newText: 'value=2', expectedHash: fingerprint(original) } },
      { id: 'failure', name: 'edit_file', arguments: { path: 'a', oldText: 'absent', newText: 'x' } },
      { id: 'create', name: 'write_file', arguments: { path: 'b', content: '中文😀'.repeat(100), expectedHash: 'missing' } },
      { id: 'changes', name: 'task_changes', arguments: { includeDiff: true } },
    ]
    let step = 0
    app.root.llm.register('changes', { models: ['test'], capabilities: { test: { contextWindowTokens: 1_000_000 } }, chat: async ({ messages = [] }) => {
      if (step === commands.length) {
        const report = JSON.parse(messages.at(-1)!.content!)
        assert.equal(report.files[0].status, 'applied')
        assert.deepEqual(report.files[0].attempts.map((attempt: { status: string }) => attempt.status), ['applied', 'failed'])
        assert.doesNotMatch(report.files[0].diff, /用户已有/)
        return { content: 'changes delivered' }
      }
      return { toolCalls: [commands[step++]] }
    } })
    app.input.write('/model changes/test\n/budget {"maxModelRequests":12}\nmock edit task\n/changes\n/diff 0\n/diff 1\n')
    await app.waitFor('[diff truncated; continue: /diff 1 ')
    assert.match(app.text(), /applied a failedAttempts=1/)
    assert.match(app.text(), /-value=1\r\n\+value=2/)
    assert.equal(await fs.readFile(path.join(workspace, 'a'), 'utf8'), original.replace('value=1', 'value=2'))
    const match = app.text().match(/continue: \/diff 1 (\d+)/)!
    app.input.write(`/diff 1 ${match[1]}\n/diff -1\n`)
    await app.waitFor('offset must be a nonnegative safe integer')
    assert.doesNotMatch(app.text(), /�/)
    const state = app.root.sessions.latestRun(app.root.sessions.list()[0].id)!
    assert.equal(state.status, 'completed')
    assert.equal(state.counters.toolCalls, commands.length)
    // Unknown intent is visible without inferring success from current bytes.
    const unknownRun = app.root.sessions.beginRun(state.sessionId, {}, 'mock')
    app.root.sessions.append(state.sessionId, 'file/change', { changeId: 'unknown', path: 'a', tool: 'write_file', before: { text: null, hash: 'missing' }, after: { text: 'maybe', hash: fingerprint('maybe') } }, unknownRun)
    app.root.sessions.finishRun(unknownRun, 'error'); await app.root.sessions.flush(state.sessionId)
    app.input.write('/changes\n/diff\n/reset\n/changes\n')
    await app.waitFor('unknown a'); await app.waitFor('(no confirmed diff)'); await app.waitFor('[Changes] no tracked edits in this task')
  } finally { await app.root.fiber.dispose(); await fs.rm(temp, { recursive: true, force: true }) }
})
test('Esc cancels a CLI approval and releases its input handler', { timeout: 10000 }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-cli-approval-'))
  const app = await boot(temp, path.join(temp, 'sessions'), undefined, false)
  try {
    app.root.llm.register('approval', { models: ['test'], capabilities: { test: { contextWindowTokens: 1_000_000 } },
      chat: async () => ({ toolCalls: [{ id: 'ask', name: 'ask', arguments: {} }] }) })
    app.root.tools.register({ name: 'ask', execute: async (_args, exec) => app.root.sandbox.approve({ tool: 'ask', summary: 'synthetic approval', signal: exec.signal, approval: exec.approval }) })
    app.input.write('/model approval/test\n/budget {"maxModelRequests":2}\nmock approval task\n')
    await app.waitFor('Allow this?')
    app.input.write(Buffer.from([27]))
    await app.waitFor('[Run cancelled]')
    assert.equal(app.root.sessions.latestRun(app.root.sessions.list()[0].id)?.status, 'cancelled')
    app.input.write('\n/exit\n')
  } finally {
    await app.root.fiber.dispose(); assert.equal(app.input.listenerCount('data'), 0)
    assert.equal(path.dirname(temp), path.resolve(os.tmpdir())); await fs.rm(temp, { recursive: true, force: true })
  }
})
