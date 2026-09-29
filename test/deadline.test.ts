import test from 'node:test'
import assert from 'node:assert/strict'
import type { Clock } from '../src/core/run-budget-runtime.js'
import { harness } from './harness.js'
import { assertToolProtocol } from '../src/core/context-runtime.js'
import { SessionRuntime } from '../src/core/session-runtime.js'
import type { SessionEvent } from '../src/core/contracts.js'
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
test('large timeouts are rescheduled across the Node timer range without stopping early', async () => {
  const clock = new FakeClock(), entered = deferred<void>()
  let signal: AbortSignal | undefined
  const h = harness(async request => { signal = request.signal; entered.resolve(); return new Promise(() => {}) })
  h.loop.clock = clock
  const run = h.agent.send('mock', { budget: { requestTimeoutMs: 2_147_484_647 } })
  const result = assert.rejects(run, /request_timeout/)
  await entered.promise
  clock.advance(2_147_483_647)
  assert.equal(signal?.aborted, false)
  clock.advance(1000); await result
  assert.equal(clock.timers.size, 0)
})

test('terminal sync crossing the active deadline rejects completion without a conflicting finish', async () => {
  const clock = new FakeClock(), persisted: SessionEvent[] = []
  const h = harness(async () => ({ content: 'done' }))
  h.loop.clock = clock
  h.sessions.attachStore(h.session.id, {
    append: async event => { persisted.push(structuredClone(event)); if (event.type === 'run/finish') clock.advance(20) },
    read: async () => persisted, close: async () => {},
  })
  await assert.rejects(h.agent.send('mock', { budget: { maxActiveDurationMs: 10 } }), /timeout/)
  const state = h.sessions.latestRun(h.session.id)!
  assert.equal(state.status, 'timeout')
  assert.equal(state.counters.activeDurationMs, 20)
  assert.equal(h.sessions.taskCounters(h.session.id, state.taskId).activeDurationMs, 20)
  assert.deepEqual(state.terminalCommit, { status: 'uncertain', terminalStatus: 'completed', activeDurationMs: 20 })
  assert.equal(h.session.events.filter(e => e.type === 'run/finish').length, 1)
  await assert.rejects(h.agent.send('next'), /commit uncertain/)
  assert.throws(() => h.sessions.clear(h.session.id), /commit uncertain/)
  await h.sessions.flush(h.session.id)
  assert.equal(h.sessions.latestRun(h.session.id)?.status, 'timeout')
  const restored = new SessionRuntime()
  await restored.restore({ read: async () => persisted, append: async () => {}, close: async () => {} })
  assert.equal(restored.latestRun(h.session.id)?.status, 'completed')
  assert.equal(restored.get(h.session.id).events.filter(e => e.type === 'run/finish').length, 1)
  const interrupted = new SessionRuntime()
  await interrupted.restore({ read: async () => persisted.filter(e => e.type !== 'run/finish'), append: async () => {}, close: async () => {} })
  assert.equal(interrupted.latestRun(h.session.id)?.status, 'error')
  assert.equal(interrupted.get(h.session.id).events.filter(e => e.type === 'run/finish').length, 1)
  assert.equal(clock.timers.size, 0)
})

test('terminal sync is bounded, cancellation wins the completion race and late sync stays uncertain', async () => {
  for (const mode of ['active', 'finalization', 'cancel', 'failure', 'success'] as const) {
    const clock = new FakeClock(), entered = deferred<void>(), sync = deferred<void>(), abort = new AbortController()
    const h = harness(async () => ({ content: 'done' }))
    h.loop.clock = clock
    h.sessions.attachStore(h.session.id, {
      append: async event => { if (event.type === 'run/finish') { entered.resolve(); await sync.promise; if (mode === 'failure') throw new Error('terminal sync failed') } },
      read: async () => [], close: async () => {},
    })
    const run = h.agent.send('mock', { signal: abort.signal, budget: {
      ...(mode === 'finalization' ? {} : { maxActiveDurationMs: 10 }), finalizationTimeoutMs: 15,
    } })
    const result = mode === 'success' ? run : assert.rejects(run, mode === 'cancel' ? /cancelled/ : mode === 'failure' ? /sync failed/ : /timeout/)
    await entered.promise
    if (mode === 'active' || mode === 'finalization') clock.advance(mode === 'active' ? 10 : 15)
    if (mode === 'cancel') { sync.resolve(); abort.abort() }
    if (mode === 'failure' || mode === 'success') { clock.advance(3); sync.resolve() }
    await result
    const state = h.sessions.latestRun(h.session.id)!
    assert.equal(state.status, mode === 'success' ? 'completed' : mode === 'cancel' ? 'cancelled' : mode === 'failure' ? 'error' : 'timeout')
    assert.equal(state.terminalCommit?.status, mode === 'success' ? 'confirmed' : 'uncertain')
    assert.equal(h.session.events.filter(e => e.type === 'run/finish').length, 1)
    assert.equal(clock.timers.size, 0)
    sync.resolve()
    if (mode === 'failure') await assert.rejects(h.sessions.flush(h.session.id), /sync failed/)
    else await h.sessions.flush(h.session.id)
    assert.equal(h.sessions.latestRun(h.session.id)?.status, state.status)
    if (mode !== 'success') await assert.rejects(h.agent.send('next'), /commit uncertain|storage failed/)
  }
})

test('error-path terminal cleanup has an independent bound and preserves the original stop reason', async () => {
  const clock = new FakeClock(), entered = deferred<void>(), sync = deferred<void>()
  const h = harness(async () => ({ content: 'never' }))
  h.loop.clock = clock
  h.sessions.attachStore(h.session.id, {
    append: async event => { if (event.type === 'run/finish') { entered.resolve(); await sync.promise } },
    read: async () => [], close: async () => {},
  })
  const run = h.agent.send('mock', { budget: { maxModelRequests: 0, finalizationTimeoutMs: 7 } })
  const result = assert.rejects(run, /max_steps/)
  await entered.promise; clock.advance(7); await result
  assert.equal(h.sessions.latestRun(h.session.id)?.status, 'max_steps')
  assert.equal(h.sessions.latestRun(h.session.id)?.terminalCommit?.status, 'uncertain')
  assert.equal(clock.timers.size, 0)
  sync.resolve(); await h.sessions.flush(h.session.id)
  await assert.rejects(h.agent.continue(), /commit uncertain/)
})

test('answer persistence crossing the deadline records timeout before the terminal snapshot', async () => {
  const clock = new FakeClock()
  const h = harness(async () => ({ content: 'done' }))
  h.loop.clock = clock
  h.sessions.attachStore(h.session.id, {
    append: async event => { if (event.type === 'assistant/message') clock.advance(20) },
    read: async () => [], close: async () => {},
  })
  await assert.rejects(h.agent.send('mock', { budget: { maxActiveDurationMs: 10 } }), /timeout/)
  const finish = h.session.events.filter(e => e.type === 'run/finish')
  assert.equal(finish.length, 1)
  assert.equal(finish[0].data.state.status, 'timeout')
  assert.equal(h.sessions.latestRun(h.session.id)?.terminalCommit?.status, 'confirmed')
})
