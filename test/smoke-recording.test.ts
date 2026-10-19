import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createSmokeRecorder, createSmokeReplay, restoreSmokeFixture, snapshotFixture, requestFingerprint, requestMaterial, type SmokeWireOptions, type SmokeVersion } from '../scripts/smoke-recording.js'
import { harness } from './harness.js'
import { ModelNotDispatchedError } from '../src/core/model-dispatch.js'

const wire: SmokeWireOptions = { provider: 'deepseek', baseUrl: 'https://api.deepseek.com', thinking: 'enabled', sampling: 'provider-default', stream: true, includeUsage: true }
const version: SmokeVersion = { codeSHA: 'a'.repeat(40), fixtureId: 'synthetic', manifestDigest: 'b'.repeat(64), toolSchemaSha256: 'c'.repeat(64) }
const request = (purpose: 'main' | 'summary', content: string) => ({ purpose, model: 'test', maxOutputTokens: 16, system: 'fixture system', messages: [{ role: 'user' as const, content }], tools: [] })

test('request material normalizes a Windows workspace inside serialized project JSON', () => {
  const workspace = 'C:\\runner\\candidate'
  const material = requestMaterial({ ...request('main', 'same'), system: `## Project Context\nguidance\nlimits\n${JSON.stringify({ workspace, directory: '.', rules: [] })}` }, wire, workspace)
  const system = (material as { system: string }).system
  assert.equal(JSON.parse(system.split('\n').at(-1)!).workspace, '$' + '{WORKSPACE}')
  assert.equal(system.includes('C:\\runner'), false)
})

test('request material maps a resolved project root when the supplied workspace has another spelling', () => {
  const workspace = `${path.parse(process.cwd()).root}candidate${path.sep}nested${path.sep}..${path.sep}fixture`
  const resolved = path.resolve(workspace)
  const material = requestMaterial({ ...request('main', 'same'), system: `## Project Context\nguidance\nlimits\n${JSON.stringify({ workspace: resolved, directory: '.', rules: [] })}` }, wire, workspace)
  const system = (material as { system: string }).system
  assert.equal(JSON.parse(system.split('\n').at(-1)!).workspace, '$' + '{WORKSPACE}')
})

test('request material maps the real project root behind a workspace directory alias', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-workspace-alias-'))
  try {
    const real = path.join(directory, 'real'), alias = path.join(directory, 'alias')
    await fs.mkdir(real)
    await fs.symlink(real, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const canonical = await fs.realpath(alias)
    const material = requestMaterial({ ...request('main', 'same'), system: `## Project Context\nguidance\nlimits\n${JSON.stringify({ workspace: canonical, directory: '.', rules: [] })}` }, wire, alias)
    const system = (material as { system: string }).system
    assert.equal(JSON.parse(system.split('\n').at(-1)!).workspace, '$' + '{WORKSPACE}')
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('recording retains reconstructible requests, fixture bytes, streams and separate main/summary order', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-record-'))
  try {
    const workspace = path.join(directory, 'fixture')
    await fs.mkdir(workspace)
    await fs.writeFile(path.join(workspace, 'sentinel.txt'), 'offline sentinel')
    const file = path.join(directory, 'recording.jsonl')
    let calls = 0
    const recorder = createSmokeRecorder({ file, workspace, version, wire, limits: { main: 2, summary: 1 }, delegate: async input => {
      calls++
      input.onProviderEvent?.({ model: 'test', choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'synthetic_tool' } }] } }] })
      input.onReasoning?.('synthetic reasoning')
      input.onContent?.(`chunk-${calls}`)
      return { content: `chunk-${calls}`, reasoningContent: 'synthetic reasoning', finishReason: 'stop', complete: true, usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6, source: 'provider', uncertain: false } }
    } })
    await recorder.chat(request('main', 'first'))
    await recorder.chat(request('summary', 'summarize'))
    await recorder.chat(request('main', 'last'))
    await assert.rejects(recorder.chat(request('main', 'over cap')), /ceiling exceeded/)
    assert.deepEqual(recorder.counts, { main: 2, summary: 1 })
    recorder.close()
    assert.equal(calls, 3)
    const records = (await fs.readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(records.filter(entry => entry.kind === 'start').map(entry => entry.purpose), ['main', 'summary', 'main'])
    assert.equal(records[0].fixture.sha256, snapshotFixture(workspace).sha256)
    assert.equal(Buffer.from(records[0].fixture.files[0].contentBase64, 'base64').toString(), 'offline sentinel')
    assert.equal(records[1].request.messages[0].content, 'first')
    assert.equal(records[1].request.wire.thinking, 'enabled')
    assert.deepEqual(records.filter(entry => entry.kind === 'end').map(entry => entry.response.usage.totalTokens), [6, 6, 6])
    assert.equal(records.filter(entry => entry.kind === 'provider-event').length, 3)
    const restored = path.join(directory, 'restored')
    assert.equal(restoreSmokeFixture(file, restored), snapshotFixture(workspace).sha256)
    assert.equal(await fs.readFile(path.join(restored, 'sentinel.txt'), 'utf8'), 'offline sentinel')
    assert.equal(requestFingerprint(requestMaterial(request('main', `${workspace}/sentinel.txt`), wire, workspace)), requestFingerprint(requestMaterial(request('main', `${restored}/sentinel.txt`), wire, restored)))
    const replay = createSmokeReplay({ file, workspace, version, wire })
    const seen: string[] = []
    const providerEvents: unknown[] = []
    for (const [purpose, content] of [['main', 'first'], ['summary', 'summarize'], ['main', 'last']] as const) {
      const answer = await replay.chat({ ...request(purpose, content), onContent: text => seen.push(text), onProviderEvent: event => providerEvents.push(event) })
      assert.equal(answer.complete, true)
    }
    replay.assertConsumed()
    assert.deepEqual(replay.streams, { main: 2, summary: 1 })
    assert.deepEqual(seen, ['chunk-1', 'chunk-2', 'chunk-3'])
    assert.equal(providerEvents.length, 3)
    await assert.rejects(replay.chat(request('main', 'extra')), /no API fallback/)
    const mismatch = createSmokeReplay({ file, workspace, version, wire })
    await assert.rejects(mismatch.chat(request('main', 'changed')), /fingerprint\/order mismatch/)
    const wrongOrder = createSmokeReplay({ file, workspace, version, wire })
    await assert.rejects(wrongOrder.chat(request('summary', 'summarize')), /fingerprint\/order mismatch/)
    await fs.writeFile(path.join(workspace, 'sentinel.txt'), 'changed')
    assert.throws(() => createSmokeReplay({ file, workspace, version, wire }), /initial fixture mismatch/)
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('a recorded incomplete model response cannot execute a partial tool call during replay', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-record-stop-'))
  try {
    const workspace = path.join(directory, 'fixture')
    await fs.mkdir(workspace)
    await fs.writeFile(path.join(workspace, 'only.txt'), 'initial')
    const file = path.join(directory, 'recording.jsonl')
    const recorder = createSmokeRecorder({ file, workspace, version, wire, limits: { main: 1, summary: 0 }, delegate: async input => {
      input.onContent?.('partial')
      return { content: 'partial', complete: false, finishReason: 'length', toolCalls: [{ id: 'partial-tool', name: 'write', arguments: {} }], usage: { inputTokens: 5, outputTokens: 16, totalTokens: 21, source: 'provider', uncertain: false } }
    } })
    let effects = 0
    const first = harness(recorder.chat)
    first.tools.register({ name: 'write', execute: () => { effects++; return 'done' } })
    await assert.rejects(first.agent.send('same task', { budget: { contextWindowTokens: 100_000, maxOutputTokens: 16 } }), /output_limit/)
    recorder.close()
    assert.equal(effects, 0)
    const replay = createSmokeReplay({ file, workspace, version, wire })
    const second = harness(replay.chat)
    second.tools.register({ name: 'write', execute: () => { effects++; return 'done' } })
    await assert.rejects(second.agent.send('same task', { budget: { contextWindowTokens: 100_000, maxOutputTokens: 16 } }), /output_limit/)
    replay.assertConsumed()
    assert.equal(effects, 0)
    assert.equal(second.sessions.latestRun(second.session.id)?.status, 'output_limit')
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('missing provider usage ends one request once and blocks every later provider call', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-record-usage-'))
  try {
    const workspace = path.join(directory, 'fixture')
    await fs.mkdir(workspace)
    const file = path.join(directory, 'recording.jsonl')
    let calls = 0
    const recorder = createSmokeRecorder({ file, workspace, version, wire, limits: { main: 2, summary: 0, requireProviderUsage: true }, delegate: async () => { calls++; return { content: 'unknown usage', complete: true, finishReason: 'stop' } } })
    await assert.rejects(recorder.chat(request('main', 'first')), /provider usage missing/)
    await assert.rejects(recorder.chat(request('main', 'second')), /no provider call made/)
    recorder.close()
    assert.equal(calls, 1)
    const entries = (await fs.readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.equal(entries.filter(item => item.kind === 'end').length, 1)
    assert.equal(entries.at(-1).status, 'error')
    assert.match(entries.at(-1).error, /usage missing/)
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('recorder separates request ceiling and delegated pre-dispatch refusal from actual calls', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-record-reject-'))
  try {
    const workspace = path.join(directory, 'fixture')
    await fs.mkdir(workspace)
    const file = path.join(directory, 'recording.jsonl')
    let calls = 0
    const recorder = createSmokeRecorder({ file, workspace, version, wire, limits: { main: 1, summary: 0 }, delegate: async () => {
      calls++
      throw new ModelNotDispatchedError('synthetic amount cap', 'amount_limit')
    } })
    await assert.rejects(recorder.chat(request('main', 'first')), /amount cap/)
    assert.equal(recorder.counts.main, 0)
    assert.equal(calls, 1)
    const rows = (await fs.readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(rows.map(row => row.kind), ['header', 'start', 'end'])
    assert.equal(rows.at(-1).status, 'rejected')
    recorder.close()
    const replay = createSmokeReplay({ file, workspace, version, wire })
    await assert.rejects(replay.chat(request('main', 'first')), ModelNotDispatchedError)
    replay.assertConsumed()
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('strict replay permits only the declared project workspace remap and still checks system, messages and tools', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-replay-path-'))
  try {
    const original = path.join(directory, 'original'), restored = path.join(directory, 'restored')
    await fs.mkdir(original); await fs.mkdir(restored)
    await fs.writeFile(path.join(original, 'same.txt'), 'same')
    await fs.writeFile(path.join(restored, 'same.txt'), 'same')
    const file = path.join(directory, 'recording.jsonl')
    const system = (workspace: string) => `## Runtime Context\nTime: fixed\n## Project Context\nguidance\nlimits\n${JSON.stringify({ workspace, directory: '.', rules: [] })}`
    const recorder = createSmokeRecorder({ file, workspace: original, version, wire, limits: { main: 1, summary: 0 }, delegate: async () => ({ content: 'OK', complete: true, finishReason: 'stop' }) })
    await recorder.chat({ ...request('main', 'same'), system: system(original) })
    recorder.close()
    const replay = createSmokeReplay({ file, workspace: restored, version, wire, recordedProjectWorkspace: original })
    assert.equal((await replay.chat({ ...request('main', 'same'), system: system(restored) })).content, 'OK')
    replay.assertConsumed()
    const wrongWorkspace = createSmokeReplay({ file, workspace: restored, version, wire, recordedProjectWorkspace: original })
    await assert.rejects(wrongWorkspace.chat({ ...request('main', 'same'), system: system(path.join(directory, 'unrelated')) }), /workspace mismatch/)
    const changed = createSmokeReplay({ file, workspace: restored, version, wire, recordedProjectWorkspace: original })
    await assert.rejects(changed.chat({ ...request('main', 'changed'), system: system(restored) }), /fingerprint\/order mismatch/)
    const badSystem = createSmokeReplay({ file, workspace: restored, version, wire, recordedProjectWorkspace: original })
    await assert.rejects(badSystem.chat({ ...request('main', 'same'), system: system(restored).replace('Time: fixed', 'Time: changed') }), /fingerprint\/order mismatch/)
    const badTools = createSmokeReplay({ file, workspace: restored, version, wire, recordedProjectWorkspace: original })
    await assert.rejects(badTools.chat({ ...request('main', 'same'), system: system(restored), tools: [{ type: 'function', function: { name: 'changed', description: 'synthetic', parameters: {} } }] }), /fingerprint\/order mismatch/)
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('Bash replay normalizes only registered fixture cwd and duration while rejecting changed result semantics', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-replay-bash-'))
  try {
    const original = path.join(directory, 'original'), restored = path.join(directory, 'restored')
    await fs.mkdir(original); await fs.mkdir(restored)
    await fs.writeFile(path.join(original, 'same.txt'), 'same'); await fs.writeFile(path.join(restored, 'same.txt'), 'same')
    const file = path.join(directory, 'recording.jsonl')
    const call = { id: 'bash-1', type: 'function' as const, function: { name: 'bash', arguments: JSON.stringify({ command: 'node check.mjs', cwd: '.' }) } }
    const result = (cwd: string, durationMs: number) => JSON.stringify({ type: 'command', version: 1, command: 'node check.mjs', cwd, status: 'exited', exitCode: 0, signal: null, durationMs, timedOut: false, cancelled: false, stdout: { text: 'pass\n', bytes: 5, truncated: false }, stderr: { text: '', bytes: 0, truncated: false } }, null, 2)
    const messages = (cwd: string, durationMs: number) => [{ role: 'assistant' as const, content: '', tool_calls: [call] }, { role: 'tool' as const, tool_call_id: 'bash-1', content: result(cwd, durationMs) }]
    const recorder = createSmokeRecorder({ file, workspace: original, version, wire, limits: { main: 1, summary: 0 }, delegate: async () => ({ content: 'OK', complete: true }) })
    await recorder.chat({ ...request('main', 'same'), messages: messages(original, 960.4) })
    recorder.close()
    const replay = () => createSmokeReplay({ file, workspace: restored, version, wire, recordedBashFixtureWorkspace: original })
    const base = { ...request('main', 'same'), messages: messages(restored, 5.2) }
    const accepted = replay()
    assert.equal((await accepted.chat(base)).content, 'OK'); accepted.assertConsumed()
    const rootOnly = replay()
    assert.equal((await rootOnly.chat({ ...base, messages: messages(restored, 960.4) })).content, 'OK')
    const durationOnly = createSmokeReplay({ file, workspace: original, version, wire, recordedBashFixtureWorkspace: original })
    assert.equal((await durationOnly.chat({ ...base, messages: messages(original, 1) })).content, 'OK')
    type CommandResult = { command: string; cwd: string; exitCode: number; timedOut: boolean; cancelled: boolean; stdout: { text: string; truncated: boolean } }
    for (const [name, mutate] of [
      ['stdout', (x: CommandResult) => { x.stdout.text = 'fail\n' }],
      ['exitCode', (x: CommandResult) => { x.exitCode = 1 }],
      ['command', (x: CommandResult) => { x.command = 'node other.mjs' }],
      ['timeout', (x: CommandResult) => { x.timedOut = true }],
      ['cancel', (x: CommandResult) => { x.cancelled = true }],
      ['truncation', (x: CommandResult) => { x.stdout.truncated = true }],
      ['relative cwd', (x: CommandResult) => { x.cwd = path.join(restored, 'src') }],
      ['outside cwd', (x: CommandResult) => { x.cwd = directory }],
    ] as const) {
      const changed = JSON.parse(result(restored, 5.2)); mutate(changed)
      await assert.rejects(replay().chat({ ...base, messages: [{ role: 'assistant' as const, content: '', tool_calls: [call] }, { role: 'tool' as const, tool_call_id: 'bash-1', content: JSON.stringify(changed, null, 2) }] }), /no API fallback/, name)
    }
    const changedCall = { ...call, function: { ...call.function, arguments: JSON.stringify({ command: 'node other.mjs', cwd: '.' }) } }
    await assert.rejects(replay().chat({ ...base, messages: [{ role: 'assistant' as const, content: '', tool_calls: [changedCall] }, base.messages[1]!] }), /no API fallback/)
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})
