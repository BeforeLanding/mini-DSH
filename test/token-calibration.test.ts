import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SessionRuntime } from '../src/core/session-runtime.js'
import { parseLog } from '../src/core/event-store.js'
import { formatInspect, inspectSession } from '../src/core/session-inspect.js'
import type { SessionEvent } from '../src/core/contracts.js'
import type { Usage } from '../src/core/budget.js'
import { TokenObservationCollector, applyTokenCalibration, calibrateTokenEstimate, collectTokenErrors } from '../src/core/token-calibration.js'

const usage = (inputTokens: number, source: Usage['source'] = 'provider'): Usage =>
  ({ inputTokens, outputTokens: 1, totalTokens: inputTokens + 1, source, uncertain: source === 'estimated' })

function events() {
  let seq = 0
  return (type: SessionEvent['type'], data: Record<string, unknown>, runId = 'run-1') => ({
    version: 1 as const, sessionId: 'session-1', id: `event-${++seq}`, seq, at: '2026-10-20T00:00:00.000Z', type, data, runId,
    taskId: 'task-1',
  }) as unknown as SessionEvent
}

test('summary retries stay in the summary group and errors are computed from provider usage only', () => {
  const event = events()
  const digest = 'a'.repeat(64)
  const list = [
    event('session/config', { model: 'deepseek-chat', budget: {} }),
    event('context/summary-start', { trigger: 'pressure', budgetTokens: 1000, projectedTokens: 900, plannedStart: 1, plannedEnd: 5, plannedNodes: 4 }),
    event('model/start', { taskId: 'task-1', runId: 'run-1', requestId: 's1', estimatedInputTokens: 100, model: 'deepseek-chat', schemaDigest: digest }),
    event('model/usage', { taskId: 'task-1', runId: 'run-1', requestId: 's1', usage: usage(200) }),
    event('model/start', { taskId: 'task-1', runId: 'run-1', requestId: 's2', estimatedInputTokens: 100, model: 'deepseek-chat', schemaDigest: digest }),
    event('model/usage', { taskId: 'task-1', runId: 'run-1', requestId: 's2', usage: usage(300) }),
    event('context/summary-end', { startSeq: 2, outcome: { kind: 'applied' } }),
    event('model/start', { taskId: 'task-1', runId: 'run-1', requestId: 'm1', estimatedInputTokens: 100, model: 'deepseek-chat', schemaDigest: digest }),
    event('model/usage', { taskId: 'task-1', runId: 'run-1', requestId: 'm1', usage: usage(100) }),
    event('model/start', { taskId: 'task-1', runId: 'run-1', requestId: 'm2', estimatedInputTokens: 100, model: 'deepseek-chat', schemaDigest: digest }),
    event('model/usage', { taskId: 'task-1', runId: 'run-1', requestId: 'm2', usage: usage(50) }),
  ]
  const report = collectTokenErrors(list)
  assert.equal(report.samples, 4)
  assert.equal(report.groups.length, 2)
  const summary = report.groups.find(group => group.kind === 'summary')!
  const main = report.groups.find(group => group.kind === 'main')!
  assert.equal(summary.samples, 2)
  assert.equal(main.samples, 2)
  assert.equal(report.underestimateRate, 0.5)
  assert.equal(report.medianRelativeError, -0.5)
  assert.equal(report.p50AbsRelativeError, 0.5)
  assert.equal(report.p95AbsRelativeError, 1)
  assert.deepEqual(report.excluded, { missingUsage: 0, estimatedUsage: 0, actualZero: 0, orphanUsage: 0, rejected: 0, duplicateUsage: 0, missingEstimate: 0 })
})

test('missing, estimated, zero, orphan, rejected, duplicate and unmeasured records stay out of the error samples', () => {
  const event = events()
  const list = [
    event('model/start', { taskId: 'task-1', runId: 'run-1', requestId: 'missing', estimatedInputTokens: 10 }),
    event('model/rejected', { requestId: 'rejected', reason: 'amount_limit' }),
    event('model/start', { taskId: 'task-1', runId: 'run-1', requestId: 'estimated', estimatedInputTokens: 10 }),
    event('model/usage', { taskId: 'task-1', runId: 'run-1', requestId: 'estimated', usage: usage(12, 'estimated') }),
    event('model/start', { taskId: 'task-1', runId: 'run-1', requestId: 'zero', estimatedInputTokens: 10 }),
    event('model/usage', { taskId: 'task-1', runId: 'run-1', requestId: 'zero', usage: usage(0) }),
    event('model/usage', { taskId: 'task-1', runId: 'run-1', requestId: 'orphan', usage: usage(10) }),
    event('model/start', { taskId: 'task-1', runId: 'run-1', requestId: 'duplicate', estimatedInputTokens: 10 }),
    event('model/usage', { taskId: 'task-1', runId: 'run-1', requestId: 'duplicate', usage: usage(10) }),
    event('model/usage', { taskId: 'task-1', runId: 'run-1', requestId: 'duplicate', usage: usage(10) }),
    event('model/start', { taskId: 'task-1', runId: 'run-1', requestId: 'no-estimate' }),
    event('model/usage', { taskId: 'task-1', runId: 'run-1', requestId: 'no-estimate', usage: usage(10) }),
  ]
  // rejected 请求也有 model/start；这里单独补一条，确保它计入 rejected 而不是 missing usage。
  list.push(event('model/start', { taskId: 'task-1', runId: 'run-1', requestId: 'rejected', estimatedInputTokens: 10 }))
  const report = collectTokenErrors(list)
  // duplicate 请求的第一条 usage 本身是有效样本；第二条同 requestId 的 usage 才计入 duplicateUsage。
  assert.equal(report.samples, 1)
  assert.deepEqual(report.excluded, { missingUsage: 1, estimatedUsage: 1, actualZero: 1, orphanUsage: 1, rejected: 1, duplicateUsage: 1, missingEstimate: 1 })
})

test('calibration is deterministic, opt-in, and can only make estimates more conservative', () => {
  const observations = Array.from({ length: 25 }, (_, index) => ({
    requestId: `r${index}`, kind: 'main' as const, model: 'm', schemaDigest: 's', estimatorVersion: 'nx08c-v1',
    estimatedInputTokens: 100, actualInputTokens: 120,
  }))
  const disabled = calibrateTokenEstimate(observations)
  assert.equal(disabled.reason, 'disabled')
  assert.equal(disabled.multiplier, 1)
  const applied = calibrateTokenEstimate(observations, { enabled: true })
  assert.equal(applied.reason, 'applied')
  assert.equal(applied.ratio, 1.2)
  assert.equal(applied.multiplier, 1.32)
  assert.deepEqual(applied, calibrateTokenEstimate(observations, { enabled: true }))
  const cold = calibrateTokenEstimate(observations.slice(0, 5), { enabled: true })
  assert.equal(cold.reason, 'insufficient-samples')
  assert.equal(cold.multiplier, 1)
  const extreme = calibrateTokenEstimate(observations.map(item => ({ ...item, actualInputTokens: 1e12 })), { enabled: true, maxMultiplier: 3 })
  assert.equal(extreme.multiplier, 3)
  assert.equal(applyTokenCalibration(100, extreme), 300)
  assert.equal(applyTokenCalibration(100, disabled), 100)
  assert.equal(applyTokenCalibration(100, { ...applied, multiplier: Number.NaN }), 100)
})

test('inspect exposes the same token error summary that a JSONL replay recomputes', async () => {
  const runtime = new SessionRuntime()
  const session = runtime.create()
  const run = runtime.beginRun(session.id, {}, 'offline')
  const scope = { taskId: run.taskId, runId: run.runId }
  runtime.append(session.id, 'model/start', { ...scope, requestId: 'req', estimatedInputTokens: 100, model: 'deepseek-chat', schemaDigest: 'b'.repeat(64) }, run)
  runtime.append(session.id, 'model/usage', { ...scope, requestId: 'req', usage: usage(120) }, run)
  runtime.append(session.id, 'model/end', { requestId: 'req', complete: true }, run)
  runtime.finishRun(run, 'completed')
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-token-error-'))
  const file = path.join(directory, 'events.jsonl')
  try {
    const text = session.events.map(event => JSON.stringify(event) + '\n').join('')
    await fs.writeFile(file, text)
    const report = await inspectSession(file)
    assert.equal(report.tokenError.samples, 1)
    assert.equal(report.tokenError.medianRelativeError, -1 / 6)
    assert.equal(report.tokenError.groups[0]?.model, 'deepseek-chat')
    assert.match(formatInspect(report), /Token error \(provider usage only\): 1 samples/)
    const replay = collectTokenErrors(parseLog(text, session.id))
    assert.deepEqual(replay, report.tokenError)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('the collector is usable incrementally and its summary is stable', () => {
  const event = events()
  const collector = new TokenObservationCollector()
  collector.observe(event('model/start', { taskId: 'task-1', runId: 'run-1', requestId: 'one', estimatedInputTokens: 10 }))
  collector.observe(event('model/usage', { taskId: 'task-1', runId: 'run-1', requestId: 'one', usage: usage(10) }))
  const first = collector.summary()
  const second = collector.summary()
  assert.deepEqual(first, second)
  assert.equal(collector.observations().length, 1)
  assert.equal(first.medianRelativeError, 0)
})
