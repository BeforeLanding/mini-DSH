import test from 'node:test'
import assert from 'node:assert/strict'
import type { Clock } from '../src/core/run-budget-runtime.js'
import { harness } from './harness.js'
import { assertToolProtocol } from '../src/core/context-runtime.js'
class FakeClock implements Clock {
  time = 0
  timers = new Map<number, { at: number; fn: () => void }>()
  next = 0
  now() { return this.time }
  setTimeout(fn: () => void, ms: number) { const id = ++this.next; this.timers.set(id, { at: this.time + ms, fn }); return id }
  clearTimeout(id: unknown) { if (typeof id === 'number') this.timers.delete(id) }
  advance(ms: number) {
    const until = this.time + ms
    while (true) {
      const next = [...this.timers.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (!next || next[1].at > until) break
      this.time = next[1].at; this.timers.delete(next[0]); next[1].fn()
    }
    this.time = until
  }
}
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
test('active deadline and request timeout cancel a hung model and clear resources', async () => {
  for (const request of [false, true]) {
    const clock = new FakeClock(), entered = deferred<void>()
    let received: AbortSignal | undefined, late: ((chunk: string) => void) | undefined
    const h = harness(async ({ signal, onContent }) => { received = signal; late = onContent; entered.resolve(); return new Promise(() => {}) })
    h.loop.clock = clock
    const run = h.agent.send('mock', { budget: { maxActiveDurationMs: request ? 100 : 10, requestTimeoutMs: request ? 10 : 100 } })
    const result = assert.rejects(run, request ? /request_timeout/ : /timeout/)
    await entered.promise; clock.advance(10); await result
    assert.equal(received?.aborted, true)
    assert.equal(h.sessions.latestRun(h.session.id)?.status, request ? 'request_timeout' : 'timeout')
    assert.equal(h.sessions.latestRun(h.session.id)?.counters.modelRequests, 1)
    assert.ok(h.sessions.latestRun(h.session.id)!.counters.totalTokens > 0)
    const before = structuredClone(h.session.events); late?.('late content')
    assert.deepEqual(h.session.events, before)
    assert.equal(clock.timers.size, 0)
    assert.equal(h.session.events.filter(e => e.type === 'run/finish').length, 1)
  }
})
test('approval pauses active time but has a separate deadline', async () => {
  for (const expires of [false, true]) {
    const clock = new FakeClock(), entered = deferred<void>(), answer = deferred<boolean>()
    let step = 0
    const h = harness(async () => ++step === 1 ? { toolCalls: [{ id: 'a', name: 'approve', arguments: {} }] } : { content: 'done' })
    h.loop.clock = clock
    h.tools.register({ name: 'approve', execute: async (_args, exec) => {
      clock.advance(10)
      return exec.approval!(async () => { entered.resolve(); return answer.promise })
    } })
    const run = h.agent.send('mock', { budget: { maxActiveDurationMs: 100, approvalTimeoutMs: 1000 } })
    const result = expires ? assert.rejects(run, /approval_timeout/) : run
    await entered.promise; clock.advance(expires ? 1000 : 500)
    if (!expires) answer.resolve(true)
    await result
    const state = h.sessions.latestRun(h.session.id)!
    assert.equal(state.status, expires ? 'approval_timeout' : 'completed')
    assert.equal(state.counters.activeDurationMs, 10)
    assert.equal(state.counters.approvalDurationMs, expires ? 1000 : 500)
    assertToolProtocol(h.sessions.deriveMessages(h.session.id))
    assert.equal(clock.timers.size, 0)
  }
})
test('cancel/timeout race seals one state and uncertain running tools are not marked completed', async () => {
  const clock = new FakeClock(), entered = deferred<void>(), abort = new AbortController()
  const h = harness(async () => ({ toolCalls: ['a', 'b'].map(id => ({ id, name: 'hung', arguments: {} })) }))
  h.loop.clock = clock
  h.tools.register({ name: 'hung', execute: async () => { entered.resolve(); return new Promise(() => {}) } })
  const run = h.agent.send('mock', { signal: abort.signal, budget: { maxActiveDurationMs: 10 } })
  const result = assert.rejects(run, /timeout|cancelled/)
  await entered.promise; clock.advance(10); abort.abort(); await result
  assert.equal(h.sessions.latestRun(h.session.id)?.status, 'cancelled')
  assert.deepEqual(h.session.events.filter(e => e.type === 'tool/result').map(e => e.data.status), ['unknown', 'skipped'])
  assertToolProtocol(h.sessions.deriveMessages(h.session.id))
  assert.equal(h.session.events.filter(e => e.type === 'run/finish').length, 1)
  assert.equal(clock.timers.size, 0)
})
