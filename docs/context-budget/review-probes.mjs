import { harness } from '../../dist/test/harness.js'
import { estimateInput } from '../../dist/src/core/token-estimator.js'
import { SessionRuntime } from '../../dist/src/core/session-runtime.js'

// Diagnostic probes for the ca1e2c4 review, not regression assertions or CI gates.
// Run after pnpm build. No API, filesystem store, or real tool is invoked.
let captured
const history = harness(async request => {
  captured = request
  return { content: 'ok' }
})
await history.agent.send('old-context '.repeat(100))
const oldTask = history.sessions.latestRun(history.session.id).taskId
const fullInput = estimateInput({
  system: '', tools: [],
  messages: [...history.sessions.deriveMessages(history.session.id), { role: 'user', content: 'current' }],
})
const policy = {
  contextWindowTokens: fullInput + 2048 + 100,
  maxOutputTokens: 1000, minimumOutputTokens: 1, maxTotalTokens: fullInput + 100,
}
await history.agent.send('current', { budget: policy })
console.log(JSON.stringify({
  probe: 'F1-output-reservation', fullInput,
  feasibleOutputTokensWithAllHistory: 100,
  feasibleContextTotal: fullInput + 2048 + 100,
  capacity: policy.contextWindowTokens,
  actualRemovedOldTask: history.sessions.latestRun(history.session.id).removedTaskIds.includes(oldTask),
  actualMessages: captured.messages.length,
  actualOutputLimit: captured.maxOutputTokens,
}))

class FakeClock {
  time = 0
  timers = new Map()
  next = 0
  now() { return this.time }
  setTimeout(fn, ms) {
    const id = ++this.next
    this.timers.set(id, { at: this.time + ms, fn })
    return id
  }
  clearTimeout(id) { this.timers.delete(id) }
  advance(ms) {
    const until = this.time + ms
    while (true) {
      const next = [...this.timers.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (!next || next[1].at > until) break
      this.time = next[1].at
      this.timers.delete(next[0])
      next[1].fn()
    }
    this.time = until
  }
}
const clock = new FakeClock()
const terminal = harness(async () => ({ content: 'done' }))
terminal.loop.clock = clock
terminal.sessions.attachStore(terminal.session.id, {
  append: async event => { if (event.type === 'run/finish') clock.advance(20) },
  read: async () => [], close: async () => {},
})
let returned, stopReason
try { returned = await terminal.agent.send('current', { budget: { maxActiveDurationMs: 10 } }) }
catch (error) { stopReason = error.reason ?? error.message }
const terminalState = terminal.sessions.latestRun(terminal.session.id)
console.log(JSON.stringify({
  probe: 'F2-terminal-persistence', returned: returned ?? null, stopReason, elapsedMs: clock.time, limitMs: 10,
  status: terminalState.status, recordedActiveMs: terminalState.counters.activeDurationMs,
  terminalCommit: terminalState.terminalCommit,
}))
await terminal.sessions.close()

const original = new SessionRuntime()
const session = original.create()
const run = original.beginRun(session.id, {}, 'mock/test')
original.append(session.id, 'context/projection', {
  estimatedInputTokens: 1234, reservedOutputTokens: 10,
  safetyMarginTokens: 2048, removedTaskIds: ['synthetic-old-task'],
}, run)
const events = structuredClone(session.events)
const restored = new SessionRuntime()
await restored.restore({ read: async () => events, append: async () => {}, close: async () => {} })
const restoredState = restored.latestRun(session.id)
console.log(JSON.stringify({
  probe: 'F3-recovered-projection',
  eventRemovedTaskIds: ['synthetic-old-task'], eventEstimatedInputTokens: 1234,
  stateRemovedTaskIds: restoredState.removedTaskIds,
  stateEstimatedInputTokens: restoredState.estimatedInputTokens ?? null,
  status: restoredState.status,
}))
await restored.close()
