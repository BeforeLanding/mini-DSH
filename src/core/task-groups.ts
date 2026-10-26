import { TaskGroupBudgetCoordinator } from './task-group-budget.js'
import type { TaskGroupPolicy } from './task-group-budget.js'
import type { SessionRuntime } from './session-runtime.js'
import type { LlmRuntime } from './llm-runtime.js'
import type { ToolRuntime } from './tool-runtime.js'
import { memoryHash } from './memory-contracts.js'

type Sessions = Pick<SessionRuntime, keyof SessionRuntime>
export class TaskGroups {
  #groups = new Map<string, Promise<TaskGroupBudgetCoordinator>>()
  constructor(readonly sessions: Sessions, readonly policy: Partial<TaskGroupPolicy> = {}) {}
  get(sessionId: string, taskId: string) {
    const key = `${sessionId}:${taskId}`
    let group = this.#groups.get(key)
    if (!group) { group = TaskGroupBudgetCoordinator.open(this.sessions, sessionId, taskId, this.policy); this.#groups.set(key, group) }
    return group
  }
}
export function guardTaskGroup(llm: Pick<LlmRuntime, 'setDispatchGuard'>, tools: Pick<ToolRuntime, 'setAdmission'>, sessions: Sessions,
  resolve: (sessionId: string, taskId: string) => Promise<TaskGroupBudgetCoordinator>, identity: { root: boolean; agentId?: string }) {
  llm.setDispatchGuard(async (request, invoke) => {
    const scope = request.dispatchScope
    if (!scope) throw new Error('task group request is missing its scope')
    const state = sessions.latestRun(scope.sessionId)
    if (!state || state.taskId !== scope.taskId || state.runId !== scope.runId || state.status !== 'running') throw new Error('task group model scope mismatch')
    return (await resolve(scope.sessionId, scope.taskId)).dispatch(request, { root: identity.root, agentId: identity.agentId ?? scope.sessionId }, invoke)
  })
  tools.setAdmission(async execution => {
    if (!execution.sessionId || !execution.toolCallId || !execution.toolSequence) throw new Error('task group tool requires explicit run/batch scope')
    const state = sessions.latestRun(execution.sessionId)
    if (state?.status !== 'running') throw new Error('task group tool requires an active run')
    const group = await resolve(execution.sessionId, state.taskId)
    await group.admitTool({ key: memoryHash(JSON.stringify([execution.sessionId, state.runId, execution.toolSequence, execution.toolCallId])), agentId: identity.agentId ?? execution.sessionId, sessionId: execution.sessionId, runId: state.runId, toolCallId: execution.toolCallId })
  })
}
