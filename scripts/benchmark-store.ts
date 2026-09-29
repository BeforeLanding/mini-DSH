import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { SessionRuntime } from '../src/core/session-runtime.js'
import { JsonlStore } from '../src/core/event-store.js'
const count = Number(process.argv[2] ?? 1000)
if (!Number.isSafeInteger(count) || count < 1) throw new Error('positive event count required')
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-benchmark-'))
const sessions = new SessionRuntime(), session = sessions.create({ source: 'synthetic benchmark' })
const store = await JsonlStore.open(directory, session.id)
try {
  sessions.attachStore(session.id, store); await sessions.flush(session.id)
  const started = performance.now()
  for (let i = 0; i < count; i++) {
    sessions.append(session.id, 'user/message', { content: `synthetic ${i}: ` + 'x'.repeat(256) })
    await sessions.flush(session.id)
  }
  const writeMs = performance.now() - started
  const readStarted = performance.now(), events = await store.read(), readMs = performance.now() - readStarted
  assert.equal(events.length, count + 1)
  const bytes = (await fs.stat(path.join(store.directory, 'events.jsonl'))).size
  console.log(JSON.stringify({ node: process.version, platform: process.platform, events: count, bytes, writeMs: +writeMs.toFixed(2), averageSyncAppendMs: +(writeMs / count).toFixed(3), readAndValidateMs: +readMs.toFixed(2) }))
} finally {
  await sessions.close()
  assert.equal(path.dirname(directory), path.resolve(os.tmpdir()))
  await fs.rm(directory, { recursive: true, force: true })
}
