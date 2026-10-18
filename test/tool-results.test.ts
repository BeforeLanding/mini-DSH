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
import { createHarness } from '../src/app/create-harness.js'
import { resolveV2Arms } from '../scripts/eval-v2-plan.js'
import { estimateInput } from '../src/core/token-estimator.js'

async function bootResults(workspace: string) {
  const root = new Context()
  for (const plugin of [tools, systemPrompt, sessions, agents, agentLoop, llm]) await root.plugin(plugin)
  await root.plugin(sandbox, { workspace, autoApprove: true })
  return root
}

test('truncated tool results keep a tail window whose middle is recoverable through the ref', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'result-tail-'))
  const root = await bootResults(workspace)
  const original = 'A'.repeat(100) + 'MIDDLE' + 'B'.repeat(100) + 'TAIL-SENTINEL'
  try {
    await root.plugin(toolResults, { maxPreviewBytes: 128, maxReadBytes: 7 })
    await root.plugin(bash)
    root.tools.register({ name: 'large-text', execute() { return original } })
    const generic = await root.tools.execute('large-text', {}, { sessionId: 's' })
    const value = generic.value as { ref: string; preview: string; tail?: string; omittedBytes?: number; resumeOffset?: number }
    const command = await root.tools.execute('bash', { command: `node -e 'process.stdout.write(${JSON.stringify(original)})'` }, { sessionId: 's' })
    const stream = (command.value as CommandResult).stdout
    for (const item of [{ text: value.preview, tail: value.tail, omittedBytes: value.omittedBytes, resumeOffset: value.resumeOffset, ref: value.ref }, stream]) {
      assert.ok(original.startsWith(item.text)); assert.ok(!item.text.includes('TAIL-SENTINEL'))
      assert.ok(item.tail?.endsWith('TAIL-SENTINEL'))
      assert.equal(item.omittedBytes, Buffer.byteLength(original) - Buffer.byteLength(item.text) - Buffer.byteLength(item.tail!))
      assert.equal(item.resumeOffset, Buffer.byteLength(item.text))
      let middle = '', offset = item.resumeOffset!, remaining = item.omittedBytes!
      while (remaining > 0) {
        const page = await root.tools.execute('read_tool_result', { ref: item.ref, offset, maxBytes: Math.min(7, remaining) }, { sessionId: 's' })
        assert.equal(page.isError, false)
        const data = page.value as { content: string; nextOffset: number }
        middle += data.content; remaining -= Buffer.byteLength(data.content); offset = data.nextOffset
      }
      assert.equal(item.text + middle + item.tail, original)
    }
    assert.ok(root.tools.renderResult(generic).includes('TAIL-SENTINEL'))
  } finally { await root.fiber.dispose(); await fs.rm(workspace, { recursive: true, force: true }) }
})

test('tail windows stay inside UTF-8 boundaries and never appear without truncation', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'result-utf8-tail-'))
  const root = await bootResults(workspace)
  try {
    await root.plugin(toolResults, { maxPreviewBytes: 32 })
    await root.plugin(bash)
    let output = '中'.repeat(40)
    root.tools.register({ name: 'utf8-text', execute() { return output } })
    const generic = await root.tools.execute('utf8-text', {}, { sessionId: 's' })
    const value = generic.value as { ref: string; preview: string; tail?: string; omittedBytes?: number; resumeOffset?: number }
    const command = await root.tools.execute('bash', { command: `node -e 'process.stdout.write(${JSON.stringify(output)})'` }, { sessionId: 's' })
    const stream = (command.value as CommandResult).stdout
    const decoder = new TextDecoder('utf-8', { fatal: true })
    for (const item of [{ text: value.preview, tail: value.tail, omittedBytes: value.omittedBytes, resumeOffset: value.resumeOffset, ref: value.ref }, stream]) {
      decoder.decode(Buffer.from(item.text)); decoder.decode(Buffer.from(item.tail!))
      const middle = await root.tools.execute('read_tool_result', { ref: item.ref, offset: item.resumeOffset, maxBytes: item.omittedBytes }, { sessionId: 's' })
      assert.equal(middle.isError, false)
      const text = (middle.value as { content: string }).content
      decoder.decode(Buffer.from(text))
      assert.equal(item.text + text + item.tail, output)
    }
    output = 'x'.repeat(32)
    const small = await root.tools.execute('utf8-text', {}, { sessionId: 's' })
    assert.equal((small.value as { tail?: string; ref?: string; previewTruncated?: boolean } | null)?.tail, undefined)
    assert.equal((small.value as { ref?: string } | null)?.ref, undefined)
    assert.equal((small.value as { previewTruncated?: boolean } | null)?.previewTruncated, undefined)
    output += 'y'
    const boundary = await root.tools.execute('utf8-text', {}, { sessionId: 's' })
    assert.equal((boundary.value as { tail?: string }).tail, undefined)
    assert.ok((boundary.value as { ref?: string }).ref)
    const smallStream = await root.tools.execute('bash', { command: `node -e 'process.stdout.write("x".repeat(16))'` }, { sessionId: 's' })
    assert.equal((smallStream.value as CommandResult).stdout.tail, undefined)
    assert.equal((smallStream.value as CommandResult).stdout.ref, undefined)
    const edgeStream = await root.tools.execute('bash', { command: `node -e 'process.stdout.write("x".repeat(17))'` }, { sessionId: 's' })
    assert.equal((edgeStream.value as CommandResult).stdout.tail, undefined)
    const tiny = await bootResults(workspace)
    try {
      await tiny.plugin(toolResults, { maxPreviewBytes: 8 })
      tiny.tools.register({ name: 'tiny-text', execute() { return 'abcdefghijk' } })
      const result = await tiny.tools.execute('tiny-text', {}, { sessionId: 'tiny' })
      assert.equal((result.value as { tail?: string }).tail, 'k')
    } finally { await tiny.fiber.dispose() }
  } finally { await root.fiber.dispose(); await fs.rm(workspace, { recursive: true, force: true }) }
})

test('Bash streams carry head and tail windows without duplicating the middle', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'result-dual-tail-'))
  const root = await bootResults(workspace)
  try {
    await root.plugin(toolResults, { maxPreviewBytes: 32 })
    await root.plugin(bash)
    const result = await root.tools.execute('bash', { command: `node -e 'process.stdout.write("o".repeat(100));process.stderr.write("e".repeat(100))'` }, { sessionId: 's' })
    const { stdout, stderr } = result.value as CommandResult
    assert.notEqual(stdout.ref, stderr.ref)
    for (const stream of [stdout, stderr]) {
      assert.ok(stream.ref); assert.equal(stream.previewTruncated, true)
      assert.ok(Buffer.byteLength(stream.text) <= 16)
      assert.ok(Buffer.byteLength(stream.tail!) <= 4)
      assert.ok(Buffer.byteLength(stream.text) + Buffer.byteLength(stream.tail!) < stream.bytes)
      assert.equal(stream.omittedBytes, stream.bytes - Buffer.byteLength(stream.text) - Buffer.byteLength(stream.tail!))
    }
  } finally { await root.fiber.dispose(); await fs.rm(workspace, { recursive: true, force: true }) }
})

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

test('Baseline and Full complete log-dependent diagnostics with bounded input and real ref retrieval', async () => {
  const sizes = [4096, 256 * 1024] as const
  const arms = resolveV2Arms(1_000_000, '1m').filter(arm => arm.name === 'baseline' || arm.name === 'full')
  const rows: { bytes: number; arm: string; status: string; answer: string; input: number; calls: number; toolCalls: number; truncations: number; promptDigests: number; readRef?: string; bashRef?: string }[] = []
  for (const bytes of sizes) {
    // ASCII keeps the advertised byte offset exact. The answer is in neither the head nor tail preview.
    const offset = Math.floor(bytes / 2)
    const marker = 'DIAGNOSTIC_VALUE=phase-7c92\n'
    const header = `DIAGNOSTIC_OFFSET=${offset}\n`
    const log = header + 'x'.repeat(offset - header.length) + marker + 'y'.repeat(bytes - offset - marker.length)
    assert.equal(Buffer.byteLength(log), bytes)
    for (const arm of arms) {
      const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'result-arm-'))
      let tick = 0, calls = 0, readRef: string | undefined
      const inputs: number[] = []
      const harness = await createHarness({
        workspace, profile: 'coding', autoApprove: true,
        contextLayout: arm.promptLayout.frozen ? 'frozen' : 'live',
        toolOutputMaxPreviewBytes: arm.toolOutput.bounded ? undefined : 64 * 1024 * 1024,
        runtimeTime: () => new Date(Date.UTC(2026, 0, 1) + 1000 * tick++).toISOString(),
        commandRunner: async options => ({
          type: 'command', version: 1, command: options.command, cwd: options.cwd,
          status: 'exited', exitCode: 0, signal: null, durationMs: 0, timedOut: false, cancelled: false,
          stdout: { text: log, bytes, truncated: false }, stderr: { text: '', bytes: 0, truncated: false },
        }),
        adapter: { provider: 'scripted', model: 'diagnostic', capabilities: { diagnostic: { contextWindowTokens: 1_000_000 } },
          async chat(request) {
            inputs.push(estimateInput(request)); calls++
            const toolMessage = request.messages?.filter(message => message.role === 'tool').at(-1)?.content ?? ''
            if (!toolMessage) return { toolCalls: [{ id: `bash-${calls}`, name: 'bash', arguments: { command: 'node diagnostic.mjs' } }] }
            const answer = /DIAGNOSTIC_VALUE=([a-z0-9-]+)/.exec(toolMessage)?.[1]
            if (answer) return { content: answer }
            const command = JSON.parse(toolMessage) as CommandResult
            const location = /DIAGNOSTIC_OFFSET=(\d+)/.exec(command.stdout.text)?.[1]
            assert.ok(location, 'the Bash preview must give a byte location for selective retrieval')
            assert.ok(command.stdout.ref, 'a missing middle requires a real stored ref')
            readRef = command.stdout.ref
            return { toolCalls: [{ id: `read-${calls}`, name: 'read_tool_result', arguments: { ref: readRef, offset: Number(location), maxBytes: 128 } }] }
          } },
      })
      try {
        const session = harness.root.sessions.create({ source: 'offline-log-discrimination' })
        const agent = harness.root.agents.create({ sessionId: session.id, model: 'scripted/diagnostic', loop: harness.root.agentLoop, budget: arm.budget })
        const answer = await agent.send('Run the diagnostic command and report DIAGNOSTIC_VALUE from its log.')
        const state = harness.root.sessions.latestRun(session.id)!
        const results = session.events.filter(event => event.type === 'tool/result')
        const bashResult = JSON.parse(results[0]!.data.content) as CommandResult
        assert.equal(results[0]!.data.name, 'bash')
        assert.equal(bashResult.stdout.previewTruncated === true, bytes === 256 * 1024 && arm.name === 'full')
        if (readRef) {
          assert.equal(results[1]!.data.name, 'read_tool_result')
          assert.equal(results[1]!.data.isError, false)
          assert.ok(results[1]!.data.content.includes(marker.trim()))
        }
        const digests = session.events.filter(event => event.type === 'context/projection').map(event => event.data.systemPromptDigest)
        rows.push({ bytes, arm: arm.name, status: state.status, answer, input: inputs.reduce((sum, value) => sum + value, 0), calls,
          toolCalls: state.counters.toolCalls, truncations: state.counters.previewTruncations, promptDigests: new Set(digests).size,
          readRef, bashRef: bashResult.stdout.ref })
      } finally { await harness.root.sessions.close(); await harness.dispose(); await fs.rm(workspace, { recursive: true, force: true }) }
    }
  }
  for (const row of rows) {
    assert.equal(row.status, 'completed'); assert.equal(row.answer, 'phase-7c92')
    assert.equal(row.truncations, row.bytes === 256 * 1024 && row.arm === 'full' ? 1 : 0)
    assert.equal(row.toolCalls, row.bytes === 256 * 1024 && row.arm === 'full' ? 2 : 1)
    assert.equal(row.calls, row.toolCalls + 1)
    assert.equal(row.promptDigests, row.arm === 'full' ? 1 : row.calls)
  }
  const small = rows.filter(row => row.bytes === 4096)
  const large = rows.filter(row => row.bytes === 256 * 1024)
  assert.equal(large[1]!.readRef, large[1]!.bashRef)
  assert.equal(large[0]!.readRef, undefined)
  // A 128-byte targeted page adds a request, so allow 50% of Baseline's cumulative input.
  // The 256 KiB raw result enters Baseline's next request, while Full carries a 16 KiB preview.
  assert.ok(large[1]!.input < large[0]!.input * 0.5, JSON.stringify(large))
  assert.ok(Math.abs(small[1]!.input - small[0]!.input) < small[0]!.input * 0.1, JSON.stringify(small))
  console.log('offline ChatRequest input estimates:', JSON.stringify(rows.map(({ readRef, bashRef, ...row }) => row)))
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
