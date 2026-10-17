import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createSmokeRecorder, createSmokeReplay, restoreSmokeFixture, snapshotFixture, requestFingerprint, requestMaterial, type SmokeWireOptions, type SmokeVersion } from '../scripts/smoke-recording.js'
import { harness } from './harness.js'

const wire: SmokeWireOptions = { provider: 'deepseek', baseUrl: 'https://api.deepseek.com', thinking: 'enabled', sampling: 'provider-default', stream: true, includeUsage: true }
const version: SmokeVersion = { codeSHA: 'a'.repeat(40), fixtureId: 'synthetic', manifestDigest: 'b'.repeat(64), toolSchemaSha256: 'c'.repeat(64) }
const request = (purpose: 'main' | 'summary', content: string) => ({ purpose, model: 'test', maxOutputTokens: 16, system: 'fixture system', messages: [{ role: 'user' as const, content }], tools: [] })

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
      input.onReasoning?.('synthetic reasoning')
      input.onContent?.(`chunk-${calls}`)
      return { content: `chunk-${calls}`, reasoningContent: 'synthetic reasoning', finishReason: 'stop', complete: true, usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6, source: 'provider', uncertain: false } }
    } })
    await recorder.chat(request('main', 'first'))
    await recorder.chat(request('summary', 'summarize'))
    await recorder.chat(request('main', 'last'))
    await assert.rejects(recorder.chat(request('main', 'over cap')), /ceiling exceeded/)
    recorder.close()
    assert.equal(calls, 3)
    const records = (await fs.readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(records.filter(entry => entry.kind === 'start').map(entry => entry.purpose), ['main', 'summary', 'main'])
    assert.equal(records[0].fixture.sha256, snapshotFixture(workspace).sha256)
    assert.equal(Buffer.from(records[0].fixture.files[0].contentBase64, 'base64').toString(), 'offline sentinel')
    assert.equal(records[1].request.messages[0].content, 'first')
    assert.equal(records[1].request.wire.thinking, 'enabled')
    assert.deepEqual(records.filter(entry => entry.kind === 'end').map(entry => entry.response.usage.totalTokens), [6, 6, 6])
    const restored = path.join(directory, 'restored')
    assert.equal(restoreSmokeFixture(file, restored), snapshotFixture(workspace).sha256)
    assert.equal(await fs.readFile(path.join(restored, 'sentinel.txt'), 'utf8'), 'offline sentinel')
    assert.equal(requestFingerprint(requestMaterial(request('main', `${workspace}/sentinel.txt`), wire, workspace)), requestFingerprint(requestMaterial(request('main', `${restored}/sentinel.txt`), wire, restored)))
    const replay = createSmokeReplay({ file, workspace, version, wire })
    const seen: string[] = []
    for (const [purpose, content] of [['main', 'first'], ['summary', 'summarize'], ['main', 'last']] as const) {
      const answer = await replay.chat({ ...request(purpose, content), onContent: text => seen.push(text) })
      assert.equal(answer.complete, true)
    }
    replay.assertConsumed()
    assert.deepEqual(replay.streams, { main: 2, summary: 1 })
    assert.deepEqual(seen, ['chunk-1', 'chunk-2', 'chunk-3'])
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
