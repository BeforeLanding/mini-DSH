import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { OrchestrationStore, newRootId } from '../src/orchestration/store.js'
import { decodeOrchestrationLog } from '../src/orchestration/validation.js'
import { rootStart, planRecorded } from './orchestration-fixtures.js'

async function tempRoot(t: import('node:test').TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-store-')), rootId = newRootId()
  let active: OrchestrationStore | undefined
  t.after(async () => { await active?.close().catch(() => {}); await fs.rm(directory, { recursive: true, force: true }) })
  const open = async () => (active = await OrchestrationStore.open(directory, rootId))
  return { directory, rootId, open }
}

test('orchestration store appends durable events, rejects a second writer and resumes sequence', async t => {
  const { directory, rootId, open } = await tempRoot(t)
  const store = await open()
  const first = await store.append('root/start', rootStart())
  assert.equal(first.seq, 1); assert.equal(first.rootId, rootId); assert.match(first.id, /^ev_/)
  await assert.rejects(OrchestrationStore.open(directory, rootId), /writer lock exists/)
  const text = await fs.readFile(path.join(directory, 'orchestration.jsonl'), 'utf8')
  assert.equal(text.split('\n').filter(Boolean).length, 1)
  await store.close()
  const reopened = await open()
  const second = await reopened.append('plan/recorded', planRecorded())
  assert.equal(second.seq, 2)
  const events = await reopened.read()
  assert.deepEqual(events.map(event => event.seq), [1, 2])
  assert.deepEqual(events.map(event => event.type), ['root/start', 'plan/recorded'])
  decodeOrchestrationLog(events.map(event => JSON.stringify(event) + '\n').join(''), rootId)
})

test('invalid orchestration payload never reaches disk and does not seal the store', async t => {
  const { open } = await tempRoot(t)
  const store = await open()
  await assert.rejects(store.append('root/start', { ...rootStart(), goal: '' }), /goal must be a nonempty string/)
  await store.append('root/start', rootStart())
  assert.equal((await store.read()).length, 1)
})

test('concurrent appends are serialized with unique sequence and ids', async t => {
  const { open } = await tempRoot(t)
  const store = await open()
  await store.append('root/start', rootStart())
  const appended = await Promise.all(Array.from({ length: 12 }, (_, index) => store.append('control/stop', { scope: 'dispatch', reason: `stop-${index}` })))
  assert.deepEqual(appended.map(event => event.seq), Array.from({ length: 12 }, (_, index) => index + 2))
  assert.equal(new Set(appended.map(event => event.id)).size, 12)
  const events = await store.read()
  assert.deepEqual(events.map(event => event.seq), Array.from({ length: 13 }, (_, index) => index + 1))
})

test('a half-written tail is refused and can be quarantined explicitly', async t => {
  const { directory, rootId, open } = await tempRoot(t)
  const store = await open()
  await store.append('root/start', rootStart())
  await store.close()
  const target = path.join(directory, 'orchestration.jsonl')
  await fs.appendFile(target, '{"v":1,"rootId":')
  await assert.rejects(OrchestrationStore.open(directory, rootId), /incomplete orchestration JSONL tail/)
  const backup = await OrchestrationStore.quarantineTail(directory, rootId)
  assert.match(await fs.readFile(backup, 'utf8'), /\{"v":1,"rootId":$/)
  const reopened = await open()
  assert.equal((await reopened.read()).length, 1)
})
