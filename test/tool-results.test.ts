import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ToolResultStore } from '../src/core/tool-result-store.js'

test('result store survives restart, pages Unicode bytes and isolates sessions', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-results-'))
  const signal = new AbortController().signal
  try {
    const store = new ToolResultStore({ directory, maxReadBytes: 4 })
    const saved = await store.save('s1', '中文abc', signal)
    const restarted = new ToolResultStore({ directory, maxReadBytes: 4 })
    const first = await restarted.read('s1', saved.ref, 0, 4, signal)
    assert.equal(first.content, '中'); assert.equal(first.nextOffset, 3); assert.equal(first.eof, false)
    const second = await restarted.read('s1', saved.ref, first.nextOffset, 4, signal)
    assert.equal(second.content, '文a'); assert.equal(second.nextOffset, 7)
    assert.equal((await restarted.read('s1', saved.ref, 7, 4, signal)).content, 'bc')
    await assert.rejects(restarted.read('s2', saved.ref, 0, 4, signal), /session/)
    await assert.rejects(restarted.read(undefined, saved.ref, 0, 4, signal), /sessionId/)
    await assert.rejects(restarted.read('s1', '../escape', 0, 4, signal), /reference/)
    await assert.rejects(restarted.read('s1', saved.ref, 1, 4, signal), /boundary/)
    await assert.rejects(restarted.read('s1', saved.ref, 0, 1, signal), /cannot fit/)
    await assert.rejects(restarted.read('s1', saved.ref, -1, 4, signal), /offset/)
    await assert.rejects(restarted.read('s1', saved.ref, 0, 5, signal), /maxBytes/)
    await assert.rejects(restarted.read('s1', saved.ref, 0, 4, AbortSignal.abort()), /abort/i)
    await fs.unlink(path.join(directory, `${saved.ref}.json`))
    await assert.rejects(restarted.read('s1', saved.ref, 0, 4, signal), /ENOENT/)
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('result storage bounds capture/quota, rejects corruption and recovers after failed writes', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-results-'))
  const signal = new AbortController().signal
  try {
    const store = new ToolResultStore({ directory, maxCaptureBytes: 4, maxFiles: 2 })
    const first = await store.save('s', '中文abc', signal)
    assert.equal(first.bytes, 3); assert.equal(first.truncated, true)
    assert.equal((await store.read('s', first.ref, 0, 4, signal)).captureTruncated, true)
    await store.save('s', 'abcd', signal)
    await assert.rejects(store.save('s', 'x', signal), /file limit/)
    const target = path.join(directory, `${first.ref}.json`)
    const record = JSON.parse(await fs.readFile(target, 'utf8')); record.content = 'evil'
    await fs.writeFile(target, JSON.stringify(record))
    await assert.rejects(store.read('s', first.ref, 0, 4, signal), /integrity/)
    await assert.rejects(new ToolResultStore({ directory, maxStoreBytes: 1 }).save('s', 'x', signal), /byte limit/)
    await assert.rejects(store.save('s', 'x', AbortSignal.abort()), /abort/i)
    const blocked = path.join(directory, 'blocked'); await fs.writeFile(blocked, 'x')
    const failing = new ToolResultStore({ directory: blocked })
    await assert.rejects(failing.save('s', 'x', signal), /EEXIST|ENOTDIR/)
    await fs.unlink(blocked); await failing.save('s', 'ok', signal)
    assert.throws(() => new ToolResultStore({ directory, maxCaptureBytes: 0 }), /positive/)
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

import { Context } from '@deepseek-ai/cordis'
import * as tools from '../src/plugins/tools.js'
import * as sandbox from '../src/plugins/sandbox.js'
import * as systemPrompt from '../src/plugins/system-prompt.js'
import * as sessions from '../src/plugins/session.js'
import * as agents from '../src/plugins/agent.js'
import * as agentLoop from '../src/plugins/agent-loop.js'
import * as llm from '../src/plugins/llm.js'
import * as toolResults from '../src/plugins/tool-results.js'
import * as bash from '../src/tools/bash.js'
import type { CommandResult } from '../src/core/command-runner.js'
import { JsonlStore } from '../src/core/event-store.js'

async function bootResults(workspace: string) {
  const root = new Context()
  for (const plugin of [tools, systemPrompt, sessions, agents, agentLoop, llm]) await root.plugin(plugin)
  await root.plugin(sandbox, { workspace, autoApprove: true })
  return root
}

test('Cordis model reads a large Bash log via its persistent ref while events retain only previews', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'result-integration-'))
  const root = await bootResults(workspace)
  let restarted: Context | undefined
  try {
    await root.plugin(toolResults, { maxPreviewBytes: 256, maxReadBytes: 4096 })
    await root.plugin(bash)
    let request = 0, reference = ''
    root.llm.register('mock', { models: ['test'], async chat({ messages = [], tools: schemas = [] }) {
      request++
      assert.ok(schemas.some(schema => schema.function.name === 'read_tool_result'))
      if (request === 1) return { toolCalls: [{ id: 'log', name: 'bash', arguments: { command: `node -e 'process.stdout.write("x".repeat(40000)+"TAIL")'` } }] }
      if (request === 2) {
        const text = messages.at(-1)!.content!
        assert.ok(Buffer.byteLength(text) < 2000)
        const command = JSON.parse(text) as CommandResult
        assert.equal(command.exitCode, 0); assert.equal(command.status, 'exited')
        assert.equal(command.stdout.bytes, 40004); assert.equal(command.stdout.previewTruncated, true)
        reference = command.stdout.ref!
        return { toolCalls: [{ id: 'page', name: 'read_tool_result', arguments: { ref: reference, offset: 39000, maxBytes: 4096 } }] }
      }
      assert.ok(messages.at(-1)!.content!.includes('TAIL'))
      assert.ok(messages.at(-1)!.content!.includes('"eof": true'))
      assert.ok(!messages.at(-1)!.content!.includes('[tool_result'))
      return { content: 'log inspected' }
    } })
    const session = root.sessions.create({ workspace })
    const agent = root.agents.create({ sessionId: session.id, model: 'mock/test', loop: root.agentLoop })
    assert.equal(await agent.send('inspect synthetic log'), 'log inspected')
    const results = session.events.filter(event => event.type === 'tool/result')
    assert.equal(results.length, 2)
    assert.ok(results.every(event => event.data.content.length < 2000))
    assert.equal(root.sessions.latestRun(session.id)?.status, 'completed')
    restarted = await bootResults(workspace)
    await restarted.plugin(toolResults)
    const page = await restarted.tools.execute('read_tool_result', { ref: reference, offset: 40000 }, { sessionId: session.id })
    assert.equal(page.isError, false); assert.equal((page.value as { content: string }).content, 'TAIL')
    const denied = await restarted.tools.execute('read_tool_result', { ref: reference }, { sessionId: 'other' })
    assert.equal(denied.isError, true)
  } finally { await root.fiber.dispose(); await restarted?.fiber.dispose(); await fs.rm(workspace, { recursive: true, force: true }) }
})

test('result projection preserves errors, reports storage failure and disposes without changing old runtime calls', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'result-integration-'))
  const root = await bootResults(workspace)
  try {
    const plugin = await root.plugin(toolResults, { maxPreviewBytes: 32, maxCaptureBytes: 256 })
    root.tools.register({ name: 'large-error', execute() { throw new Error('synthetic failure '.repeat(100)) } })
    const result = await root.tools.execute('large-error', {}, { sessionId: 's' })
    assert.equal(result.isError, true)
    const ref = (result.value as { ref: string }).ref
    const page = await root.tools.execute('read_tool_result', { ref }, { sessionId: 's' })
    assert.equal(page.isError, false); assert.equal((page.value as { captureTruncated: boolean }).captureTruncated, true)
    assert.match(root.tools.renderResult(page), /synthetic failure/)
    const compatible = await root.tools.execute('large-error')
    assert.equal(compatible.value, null); assert.ok(root.tools.renderResult(compatible).length > 1000)
    await plugin.dispose()
    assert.equal(root.tools.get('read_tool_result'), undefined)
    assert.equal((await root.tools.execute('large-error', {}, { sessionId: 's' })).value, null)
    const blocked = path.join(workspace, 'blocked'); await fs.writeFile(blocked, 'file')
    await root.plugin(toolResults, { directory: 'blocked', maxPreviewBytes: 32 })
    const failed = await root.tools.execute('large-error', {}, { sessionId: 's' })
    assert.equal(failed.isError, true); assert.match(root.tools.renderResult(failed), /projection failed/)
  } finally { await root.fiber.dispose(); await fs.rm(workspace, { recursive: true, force: true }) }
})

test('Bash collection flags its cap and nonzero exit logs retain retrievable error refs', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'result-bash-'))
  const root = await bootResults(workspace)
  try {
    await root.plugin(toolResults, { maxPreviewBytes: 32 })
    await root.plugin(bash, { maxCaptureBytes: 128 })
    const success = await root.tools.execute('bash', { command: `node -e 'process.stdout.write("x".repeat(1000))'` }, { sessionId: 's' })
    assert.equal(success.isError, false)
    const ref = (success.value as CommandResult).stdout.ref!
    const page = await root.tools.execute('read_tool_result', { ref }, { sessionId: 's' })
    assert.equal((page.value as { content: string }).content, 'x'.repeat(128))
    assert.equal((success.value as CommandResult).stdout.truncated, true)
    const failure = await root.tools.execute('bash', { command: `node -e 'process.stderr.write("failure ".repeat(10));process.exit(7)'` }, { sessionId: 's' })
    assert.equal(failure.isError, true)
    const errorPage = await root.tools.execute('read_tool_result', { ref: (failure.value as CommandResult).stderr.ref }, { sessionId: 's' })
    assert.equal((failure.value as CommandResult).exitCode, 7)
    assert.match(root.tools.renderResult(errorPage), /failure/)
  } finally { await root.fiber.dispose(); await fs.rm(workspace, { recursive: true, force: true }) }
})

test('command projection keeps stream refs separate and preserves exit metadata on storage failure', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'result-streams-'))
  const root = await bootResults(workspace)
  try {
    const plugin = await root.plugin(toolResults, { maxPreviewBytes: 32, maxCaptureBytes: 40 })
    await root.plugin(bash)
    const result = await root.tools.execute('bash', { command: 'printf "stdout%.0s" {1..20}; printf "stderr%.0s" {1..20} >&2; exit 9' }, { sessionId: 's' })
    const value = result.value as CommandResult
    assert.equal(result.isError, true); assert.equal(value.exitCode, 9)
    assert.notEqual(value.stdout.ref, value.stderr.ref)
    for (const [stream, expected] of [[value.stdout, 'stdout'], [value.stderr, 'stderr']] as const) {
      assert.equal(stream.storageTruncated, true); assert.equal(stream.truncated, false)
      assert.equal(stream.previewTruncated, true); assert.equal(stream.bytes, 120)
      const page = await root.tools.execute('read_tool_result', { ref: stream.ref }, { sessionId: 's' })
      assert.ok((page.value as { content: string }).content.startsWith(expected))
      assert.equal((page.value as { captureTruncated: boolean }).captureTruncated, true)
    }
    await plugin.dispose()
    await fs.writeFile(path.join(workspace, 'blocked'), 'x')
    await root.plugin(toolResults, { directory: 'blocked', maxPreviewBytes: 32 })
    const failed = await root.tools.execute('bash', { command: 'printf "out%.0s" {1..20}; printf "err%.0s" {1..20} >&2; exit 7' }, { sessionId: 's' })
    const error = failed.value as CommandResult
    assert.equal(failed.isError, true); assert.equal(error.status, 'exited'); assert.equal(error.exitCode, 7)
    assert.ok(error.stdout.storageError); assert.ok(error.stderr.storageError)
    assert.equal(error.stdout.ref, undefined); assert.ok(error.stdout.text.length <= 16)
    assert.equal(JSON.parse(root.tools.renderResult(failed)).exitCode, 7)
  } finally { await root.fiber.dispose(); await fs.rm(workspace, { recursive: true, force: true }) }
})

test('structured failed and timed-out command events restore from JSONL without replaying side effects', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'command-journal-'))
  const root = await bootResults(workspace)
  let restarted: Context | undefined, store: JsonlStore | undefined, reopened: JsonlStore | undefined
  try {
    await root.plugin(toolResults, { maxPreviewBytes: 64 })
    await root.plugin(bash, { timeoutMs: 1500 })
    const session = root.sessions.create({ workspace: await fs.realpath(workspace) })
    store = await JsonlStore.open(path.join(workspace, 'sessions'), session.id)
    root.sessions.attachStore(session.id, store)
    let requests = 0
    root.llm.register('mock', { models: ['test'], async chat({ messages = [] }) {
      if (++requests === 1) return { toolCalls: [
        { id: 'failure', name: 'bash', arguments: { command: `printf x >> once; node -e 'process.stdout.write("out".repeat(1000));process.stderr.write("bad".repeat(1000));process.exit(7)'` } },
        { id: 'timeout', name: 'bash', arguments: { command: `node -e 'process.stdout.write("waiting");process.stderr.write("pending");setInterval(()=>{},1000)'` } },
      ] }
      const results = messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content!) as CommandResult)
      assert.equal(results[0].exitCode, 7); assert.ok(results[0].stdout.ref); assert.ok(results[0].stderr.ref)
      assert.equal(results[1].status, 'timed_out'); assert.equal(results[1].timedOut, true)
      assert.equal(results[1].stdout.text, 'waiting'); assert.equal(results[1].stderr.text, 'pending')
      return { content: 'synthetic checks failed; task is not verified' }
    } })
    const agent = root.agents.create({ sessionId: session.id, model: 'mock/test', loop: root.agentLoop })
    assert.equal(await agent.send('run synthetic failing checks'), 'synthetic checks failed; task is not verified')
    assert.equal(root.sessions.latestRun(session.id)?.status, 'completed')
    const before = session.events.filter(event => event.type === 'tool/result')
    assert.equal(before.length, 2); assert.ok(before.every(event => event.data.isError))
    await root.sessions.close(); await root.fiber.dispose()
    restarted = await bootResults(workspace)
    await restarted.plugin(toolResults)
    reopened = await JsonlStore.open(path.join(workspace, 'sessions'), session.id)
    await restarted.sessions.restore(reopened, await fs.realpath(workspace))
    const after = restarted.sessions.get(session.id).events.filter(event => event.type === 'tool/result')
    assert.deepEqual(after, before)
    assert.equal(await fs.readFile(path.join(workspace, 'once'), 'utf8'), 'x')
    const command = JSON.parse(after[0].data.content) as CommandResult
    const page = await restarted.tools.execute('read_tool_result', { ref: command.stderr.ref }, { sessionId: session.id })
    assert.equal(page.isError, false); assert.equal((page.value as { content: string }).content, 'bad'.repeat(1000))
    await restarted.sessions.close()
  } finally {
    await root.fiber.dispose(); await restarted?.fiber.dispose(); await store?.close(); await reopened?.close()
    await fs.rm(workspace, { recursive: true, force: true })
  }
})
