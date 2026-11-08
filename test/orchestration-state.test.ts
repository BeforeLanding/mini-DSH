import test from 'node:test'
import assert from 'node:assert/strict'
import { foldOrchestration, orchestrationTotals } from '../src/orchestration/state.js'
import { TASK_GROUP_POLICY } from '../src/core/task-group-budget.js'
import type { OrchEventType, OrchestrationEventUnion } from '../src/orchestration/contracts.js'
import {
  ATTEMPT, BASE, COMMIT, GROUP, ROOT, SESSION, attemptFinished, attemptPlanned, attemptStarted,
  eventBuilder, integrationApplied, integrationFinished, integrationStarted, planDecision, planRecorded, rootStart, verification,
} from './orchestration-fixtures.js'

const usage = (input: number, output: number) => ({ inputTokens: input, outputTokens: output, totalTokens: input + output, source: 'provider' as const, uncertain: false })
const groupStart = (): { groupId: string; policy: typeof TASK_GROUP_POLICY; deadline: number } => ({ groupId: GROUP, policy: TASK_GROUP_POLICY, deadline: 1_000_000 })
const reserved = (requestId: string) => ({ groupId: GROUP, sessionId: SESSION, taskId: 'task', runId: 'run', agentId: 'worker', root: false, purpose: 'main' as const, reserve: 1000, requestId })

function chain() {
  const event = eventBuilder()
  return [
    event('root/start', rootStart()),
    event('plan/recorded', planRecorded()),
    event('plan/decision', planDecision()),
    event('attempt/planned', attemptPlanned()),
    event('attempt/started', attemptStarted()),
    event('attempt/session', { attemptId: ATTEMPT, sessionId: SESSION }),
    event('attempt/finished', attemptFinished()),
    event('integration/started', integrationStarted()),
    event('integration/applied', integrationApplied()),
    event('integration/finished', integrationFinished()),
    event('verification/finished', verification()),
    event('root/finish', { status: 'completed' }),
  ] satisfies OrchestrationEventUnion[]
}

test('foldOrchestration reconstructs the completed single-attempt lifecycle', () => {
  const state = foldOrchestration(chain())
  assert.equal(state.status, 'completed')
  assert.equal(state.finished?.status, 'completed')
  assert.equal(state.decision?.mode, 'single')
  assert.equal(state.attempts[ATTEMPT]?.status, 'finished')
  assert.equal(state.attempts[ATTEMPT]?.outcome, 'succeeded')
  assert.equal(state.attempts[ATTEMPT]?.commit, COMMIT)
  assert.equal(state.integration?.status, 'finished')
  assert.deepEqual(state.integration?.applied.map(item => item.attemptId), [ATTEMPT])
  assert.equal(state.verifications.length, 1)
  assert.equal(state.verifications[0]?.exitCode, 0)
  assert.equal(state.rootId, ROOT)
  assert.equal(state.baseCommit, BASE)
})

test('fold rejects invalid transitions and duplicate scope', () => {
  const beforePlan = eventBuilder()
  assert.throws(() => foldOrchestration([beforePlan('root/start', rootStart()), beforePlan('attempt/planned', attemptPlanned())] satisfies OrchestrationEventUnion[]), /requires a plan decision/)
  const wrongWave = eventBuilder()
  assert.throws(() => foldOrchestration([wrongWave('root/start', rootStart()), wrongWave('plan/recorded', planRecorded()), wrongWave('plan/decision', { ...planDecision(), waves: [['st-1'], ['st-2']] })] satisfies OrchestrationEventUnion[]), /waves do not match/)
  const lateStart = eventBuilder()
  assert.throws(() => foldOrchestration([lateStart('root/start', rootStart()), lateStart('plan/recorded', planRecorded()), lateStart('plan/decision', planDecision()), lateStart('attempt/planned', attemptPlanned()), lateStart('attempt/session', { attemptId: ATTEMPT, sessionId: SESSION })] satisfies OrchestrationEventUnion[]), /requires a started attempt/)
  const chainEvents = chain(), afterFinish = { ...eventBuilder()('control/stop', { scope: 'running', reason: 'late' }), seq: chainEvents.length + 1, id: 'ev_late' }
  assert.throws(() => foldOrchestration([...chainEvents, afterFinish] satisfies OrchestrationEventUnion[]), /after root\/finish/)
})

test('late attempt results are recorded only for terminal attempts and never change state', () => {
  const events = [...chain()]
  const late = { ...eventBuilder()('attempt/late', { attemptId: ATTEMPT, summary: 'result arrived after finish' }), seq: events.length + 1, id: 'ev_13' }
  const folded = foldOrchestration([...events, late])
  assert.equal(folded.attempts[ATTEMPT]?.outcome, 'succeeded')
  const event2 = eventBuilder()
  const notTerminal = [event2('root/start', rootStart()), event2('plan/recorded', planRecorded()), event2('plan/decision', planDecision()), event2('attempt/planned', attemptPlanned()), event2('attempt/late', { attemptId: ATTEMPT, summary: 'too early' })] satisfies OrchestrationEventUnion[]
  assert.throws(() => foldOrchestration(notTerminal), /requires a terminal attempt/)
})

test('group budget events fold into ledger totals by usage source', () => {
  const event = eventBuilder()
  const events = [
    event('root/start', rootStart()),
    event('group/start', groupStart()),
    event('group/budget-reserved', reserved('req-1')),
    event('group/model-dispatched', { groupId: GROUP, requestId: 'req-1' }),
    event('group/budget-settled', { groupId: GROUP, requestId: 'req-1', usage: usage(700, 100), overrun: false }),
    event('group/budget-reserved', reserved('req-2')),
    event('group/model-dispatched', { groupId: GROUP, requestId: 'req-2' }),
    event('group/usage-unknown', { groupId: GROUP, requestId: 'req-2' }),
    event('group/budget-reserved', reserved('req-3')),
    event('group/reservation-released', { groupId: GROUP, requestId: 'req-3' }),
  ] satisfies OrchestrationEventUnion[]
  const state = foldOrchestration(events)
  assert.equal(state.ledger.groupId, GROUP)
  assert.deepEqual(orchestrationTotals(state), { requests: 2, providerTokens: 800, estimatedTokens: 0, unknownChargedTokens: 1000, outstandingTokens: 0, cacheReadTokens: 0 })
  const orphan = eventBuilder()
  assert.throws(() => foldOrchestration([orphan('root/start', rootStart()), orphan('group/budget-reserved', reserved('req-1'))]), /unknown or cross-root task group/)
})

test('completed root requires every subtask integrated and passing verification', () => {
  const withoutVerification = chain().filter(event => event.type !== 'verification/finished')
  assert.throws(() => foldOrchestration(withoutVerification.map((event, index) => ({ ...event, seq: index + 1 })) as OrchestrationEventUnion[]), /requires passing verification/)
  const failedVerification = chain().map(event => event.type === 'verification/finished' ? { ...event, data: { ...event.data, exitCode: 1 } } : event) as OrchestrationEventUnion[]
  assert.throws(() => foldOrchestration(failedVerification), /requires passing verification/)
  const noIntegration = chain().filter(event => !event.type.startsWith('integration/') && event.type !== 'verification/finished')
  assert.throws(() => foldOrchestration(noIntegration.map((event, index) => ({ ...event, seq: index + 1 })) as OrchestrationEventUnion[]), /requires a finished integration/)
})

test('interrupted attempts keep unknown-side-effect evidence and unknown reservations keep their cause', () => {
  const event = eventBuilder()
  const interrupted = {
    attemptId: ATTEMPT, outcome: 'interrupted' as const, run: { status: 'error' }, unknownSideEffects: true,
    code: { changedFiles: [], scopeViolations: [] }, detail: 'bash was running when the process stopped',
  }
  const events = [
    event('root/start', rootStart()),
    event('plan/recorded', planRecorded()),
    event('plan/decision', planDecision()),
    event('attempt/planned', attemptPlanned()),
    event('attempt/started', attemptStarted()),
    event('attempt/session', { attemptId: ATTEMPT, sessionId: SESSION }),
    event('attempt/finished', interrupted),
    event('group/start', groupStart()),
    event('group/budget-reserved', reserved('req-1')),
    event('group/model-dispatched', { groupId: GROUP, requestId: 'req-1' }),
    event('group/usage-unknown', { groupId: GROUP, requestId: 'req-1', cause: 'crash' }),
  ] satisfies OrchestrationEventUnion[]
  const state = foldOrchestration(events)
  assert.equal(state.attempts[ATTEMPT]?.status, 'interrupted')
  assert.equal(state.attempts[ATTEMPT]?.unknownSideEffects, true)
  assert.equal(state.ledger.reservations['req-1']?.cause, 'crash')
  const late = { ...eventBuilder()('attempt/late', { attemptId: ATTEMPT, summary: 'old epoch result', epoch: 1 }), seq: events.length + 1, id: 'ev-late' }
  assert.equal(foldOrchestration([...events, late]).attempts[ATTEMPT]?.status, 'interrupted')
  const wrong = { ...eventBuilder()('attempt/late', { attemptId: ATTEMPT, summary: 'wrong epoch', epoch: 2 }), seq: events.length + 1, id: 'ev-wrong' }
  assert.throws(() => foldOrchestration([...events, wrong]), /epoch does not match/)
})

test('unknown event types and mixed roots are rejected', () => {
  const mixedEvent = eventBuilder()
  const mixed = [mixedEvent('root/start', rootStart()), { ...mixedEvent('plan/recorded', planRecorded()), rootId: 'rt_00000000-0000-4000-8000-000000000099' }] as OrchestrationEventUnion[]
  assert.throws(() => foldOrchestration(mixed), /mixes root tasks/)
  const badRoot = eventBuilder(), badStart = badRoot('root/start', rootStart())
  const badType = { ...badRoot('control/stop', { scope: 'dispatch', reason: 'x' }), type: 'future/event' as OrchEventType }
  assert.throws(() => foldOrchestration([badStart, badType] as unknown as OrchestrationEventUnion[]), /unknown orchestration event type/)
  assert.throws(() => foldOrchestration([]), /must begin with root\/start/)
})
