import test from 'node:test'
import assert from 'node:assert/strict'
import { ProviderError, ModelStreamError } from '../src/core/model-error.js'
import { parseLog } from '../src/core/event-store.js'
import { inspectSession } from '../src/core/session-inspect.js'
import { harness } from './harness.js'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

test('429 and 503 retries are separate accounted model attempts and replay cleanly', async () => {
  for (const [kind, status] of [['rate_limit', 429], ['transient', 503]] as const) {
    let calls = 0
    const h = harness(async () => ++calls === 1 ? Promise.reject(new ProviderError(kind, status, true)) : { content: 'done', complete: true })
    h.loop.random = () => 0
    assert.equal(await h.agent.send('request'), 'done')
    assert.equal(calls, 2)
    const events = h.session.events
    const starts = events.filter(event => event.type === 'model/start')
    const retries = events.filter(event => event.type === 'model/retry')
    assert.equal(starts.length, 2)
    assert.equal(retries.length, 1)
    assert.equal(retries[0]!.data.rootRequestId, starts[0]!.data.requestId)
    assert.equal(retries[0]!.data.nextRequestId, starts[1]!.data.requestId)
    assert.equal(events.filter(event => event.type === 'model/usage').length, 2)
    assert.equal(events.filter(event => event.type === 'model/end').length, 2)
    assert.equal(events.filter(event => event.type === 'run/error').length, 0)
    assert.equal(events.filter(event => event.type === 'run/finish').length, 1)
    assert.equal(h.sessions.latestRun(h.session.id)?.counters.modelRequests, 2)
    const jsonl = events.map(event => JSON.stringify(event) + '\n').join('')
    assert.deepEqual(parseLog(jsonl, h.session.id), events)
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'model-retry-'))
    try {
      const file = path.join(directory, 'events.jsonl')
      await fs.writeFile(file, jsonl)
      const report = await inspectSession(file)
      assert.equal(report.requests.retries, 1)
      assert.equal(report.requests.main, 2)
    } finally { await fs.rm(directory, { recursive: true, force: true }) }
  }
})

test('auth, partial streams, exhausted request budget and excess Retry-After never retry', async () => {
  const cases = [
    { error: new ProviderError('auth', 401), budget: undefined },
    { error: new ModelStreamError('partial', { content: 'partial', complete: false }), budget: undefined },
    { error: new ProviderError('rate_limit', 429, true), budget: { maxModelRequests: 1 } },
    { error: new ProviderError('rate_limit', 429, true, undefined, 10000), budget: { maxActiveDurationMs: 1000 } },
  ]
  for (const { error, budget } of cases) {
    let calls = 0
    const h = harness(async () => { calls++; throw error })
    await assert.rejects(h.agent.send('request', { budget }))
    assert.equal(calls, 1)
    assert.equal(h.session.events.filter(event => event.type === 'model/retry').length, 0)
    assert.equal(h.session.events.filter(event => event.type === 'run/finish').length, 1)
  }
})
