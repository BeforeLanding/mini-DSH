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
