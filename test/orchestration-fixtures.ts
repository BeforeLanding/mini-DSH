import type { AttemptFinished, OrchEventData, OrchEventType, OrchestrationEvent } from '../src/orchestration/contracts.js'

export const ROOT = 'rt_00000000-0000-4000-8000-000000000001'
export const BASE = 'a'.repeat(40)
export const COMMIT = 'b'.repeat(40)
export const ATTEMPT = 'at_00000000-0000-4000-8000-000000000002'
export const INTEGRATION = 'ig_00000000-0000-4000-8000-000000000003'
export const SESSION = '00000000-0000-4000-8000-000000000004'
export const GROUP = '11111111-1111-4111-8111-111111111111'

export const rootStart = (): OrchEventData['root/start'] => ({
  goal: 'implement a parser',
  repository: 'D:/repo',
  baseCommit: BASE,
  config: { mode: 'auto', maxWorkers: 2, maxSubtasks: 4, maxAttemptsPerSubtask: 2 },
  budget: { maxModelRequests: 96, maxTotalTokens: 2_000_000, maxWallMs: 1_800_000, maxToolCalls: 256, plannerShare: 0.1, fixReserveTokens: 200_000, maxInFlightRequests: 3 },
})

export const planRecorded = (): OrchEventData['plan/recorded'] => ({
  planId: 'pl_00000000-0000-4000-8000-000000000005',
  planVersion: 1,
  source: 'file',
  plan: {
    version: 1,
    rationale: 'one independent module',
    subtasks: [{ id: 'st-1', title: 'parser', objective: 'implement src/a.ts', writeSet: ['src/a.ts'], acceptance: { commands: ['node --test'] } }],
  },
  validation: { ok: true, waves: [['st-1']] },
})

export const planDecision = (): OrchEventData['plan/decision'] => ({ planVersion: 1, mode: 'single', reason: 'one subtask', waves: [['st-1']] })

export const attemptPlanned = (attemptId = ATTEMPT): OrchEventData['attempt/planned'] => ({
  attemptId, subtaskId: 'st-1', epoch: 1, wave: 0, baseCommit: BASE,
  budget: { maxModelRequests: 32, maxToolCalls: 64, maxTotalTokens: 1_000_000 },
})

export const attemptStarted = (attemptId = ATTEMPT): OrchEventData['attempt/started'] => ({
  attemptId, worktree: '/tmp/orchestration/worktrees/attempt', branch: 'mini-dsh/root/st-1-1', sessionDirectory: '/tmp/orchestration/sessions/attempt',
})

export const attemptFinished = (outcome: AttemptFinished['outcome'] = 'succeeded'): OrchEventData['attempt/finished'] => ({
  attemptId: ATTEMPT,
  outcome,
  run: { sessionId: SESSION, status: outcome === 'succeeded' ? 'completed' : 'error' },
  code: outcome === 'succeeded'
    ? { commit: COMMIT, tree: 'c'.repeat(40), changedFiles: ['src/a.ts'], scopeViolations: [] }
    : { changedFiles: [], scopeViolations: [] },
})

export const integrationStarted = (): OrchEventData['integration/started'] => ({ integrationId: INTEGRATION, wave: 0, baseCommit: BASE })
export const integrationApplied = (): OrchEventData['integration/applied'] => ({ integrationId: INTEGRATION, attemptId: ATTEMPT, sourceCommit: COMMIT, commit: 'd'.repeat(40) })
export const integrationFinished = (): OrchEventData['integration/finished'] => ({ integrationId: INTEGRATION, head: 'd'.repeat(40), tree: 'e'.repeat(40) })
export const verification = (exitCode = 0): OrchEventData['verification/finished'] => ({ head: 'd'.repeat(40), tree: 'e'.repeat(40), command: 'node --test', exitCode })

export function eventBuilder(rootId = ROOT) {
  let seq = 0
  return <K extends OrchEventType>(type: K, data: OrchEventData[K]): OrchestrationEvent<K> => ({
    v: 1, rootId, seq: ++seq, id: `ev_${seq}`, at: '1970-01-01T00:00:00.000Z', type, data,
  })
}
