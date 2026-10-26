import { randomUUID } from 'node:crypto'
import { estimateInput } from './token-estimator.js'
import { validUsage } from './event-validation.js'
import { ModelNotDispatchedError } from './model-dispatch.js'
import { ModelStreamError } from './model-error.js'
import type { ChatRequest, ChatResponse, EventData } from './contracts.js'
import type { SessionRuntime } from './session-runtime.js'
import type { Usage } from './budget.js'

export interface TaskGroupPolicy { maxModelRequests: number; maxToolCalls: number; maxTotalTokens: number; rootTokenFloor: number; rootRequestFloor: number; maxWallDurationMs: number }
export const TASK_GROUP_POLICY: Readonly<TaskGroupPolicy> = Object.freeze({ maxModelRequests: 64, maxToolCalls: 128, maxTotalTokens: 2_000_000, rootTokenFloor: 1_000_000, rootRequestFloor: 32, maxWallDurationMs: 900_000 })
export interface DispatchScope { sessionId: string; taskId: string; runId: string; requestId: string }
export interface GroupReservation extends DispatchScope { agentId: string; root: boolean; purpose: 'main' | 'summary'; reserve: number }
export interface GroupStart { groupId: string; policy: TaskGroupPolicy; deadline: number }
export type GroupBudgetEvent =
  | { type: 'group/start'; data: GroupStart }
  | { type: 'group/budget-reserved'; data: GroupReservation & { groupId: string } }
  | { type: 'group/model-dispatched' | 'group/reservation-released' | 'group/usage-unknown'; data: { groupId: string; requestId: string } }
  | { type: 'group/budget-settled'; data: { groupId: string; requestId: string; usage: Usage; overrun: boolean } }
  | { type: 'group/tool-admitted'; data: { groupId: string; key: string; agentId: string; sessionId: string; runId: string; toolCallId: string } }
type Reservation = GroupReservation & { status: 'reserved' | 'dispatched' | 'released' | 'settled' | 'unknown'; usage?: Usage }
type Sessions = Pick<SessionRuntime, 'get' | 'latestRun' | 'append' | 'flush'>
export function groupPolicy(overrides: Partial<TaskGroupPolicy> = {}): Readonly<TaskGroupPolicy> {
  const policy = { ...TASK_GROUP_POLICY, ...overrides }
  for (const [key, value] of Object.entries(policy)) if (!(key in TASK_GROUP_POLICY) || !Number.isSafeInteger(value) || value < (key === 'maxWallDurationMs' ? 1 : 0)) throw new Error(`invalid task group policy: ${key}`)
  if (policy.rootTokenFloor > policy.maxTotalTokens || policy.rootRequestFloor > policy.maxModelRequests || policy.maxWallDurationMs > 2_147_483_647) throw new Error('invalid root floor or group duration')
  return Object.freeze(policy)
}
export class TaskGroupBudgetCoordinator {
  #queue: Promise<void> = Promise.resolve()
  #reservations = new Map<string, Reservation>()
  #tools = new Set<string>()
  #failure: unknown
  #overrun = false
  #abort = new AbortController()
  readonly start: GroupStart
  private constructor(readonly sessions: Sessions, readonly rootSessionId: string, readonly rootTaskId: string, start: GroupStart, private now: () => number) { this.start = Object.freeze({ ...start, policy: groupPolicy(start.policy) }) }
  static async open(sessions: Sessions, rootSessionId: string, rootTaskId: string, overrides: Partial<TaskGroupPolicy> = {}, now = Date.now) {
    const events = sessions.get(rootSessionId).events.filter(event => event.taskId === rootTaskId)
    const saved = events.find(event => event.type === 'group/start')
    const start: GroupStart = saved?.type === 'group/start' ? saved.data : { groupId: randomUUID(), policy: { ...groupPolicy(overrides) }, deadline: now() + groupPolicy(overrides).maxWallDurationMs }
    const group = new TaskGroupBudgetCoordinator(sessions, rootSessionId, rootTaskId, start, now)
    if (!saved) await group.#persist({ type: 'group/start', data: start })
    else for (const event of events) if (event.type.startsWith('group/')) group.#fold(event as GroupBudgetEvent)
    // Crash before a durable dispatch intent: release. After intent: retain the reservation as unknown.
    for (const [requestId, reservation] of group.#reservations) {
      if (reservation.status === 'reserved') await group.#persist({ type: 'group/reservation-released', data: { groupId: start.groupId, requestId } })
      if (reservation.status === 'dispatched') await group.#persist({ type: 'group/usage-unknown', data: { groupId: start.groupId, requestId } })
    }
    return group
  }
  #serial<T>(work: () => Promise<T>) {
    const operation = this.#queue.then(async () => { if (this.#failure) throw new Error('group persistence failed', { cause: this.#failure }); return work() })
    this.#queue = operation.then(() => {}, () => {}); return operation
  }
  #scope() {
    const state = this.sessions.latestRun(this.rootSessionId)
    if (!state || state.taskId !== this.rootTaskId) throw new Error('root task scope changed')
    return state
  }
  async #persist(event: GroupBudgetEvent) {
    try { this.sessions.append(this.rootSessionId, event.type, event.data, this.#scope()); await this.sessions.flush(this.rootSessionId) }
    catch (error) { this.#failure = error; this.#abort.abort(); throw error }
    this.#fold(event)
  }
  #fold(event: GroupBudgetEvent) {
    if (event.data.groupId !== this.start.groupId) throw new Error('group scope mismatch')
    if (event.type === 'group/start') { groupPolicy(event.data.policy); return }
    if (event.type === 'group/tool-admitted') {
      if (this.#tools.has(event.data.key)) throw new Error('duplicate group tool admission')
      this.#tools.add(event.data.key); return
    }
    const requestId = event.data.requestId
    if (event.type === 'group/budget-reserved') {
      if (this.#reservations.has(requestId)) throw new Error('duplicate group request reservation')
      this.#reservations.set(requestId, { ...event.data, status: 'reserved' }); return
    }
    const reservation = this.#reservations.get(requestId)
    if (!reservation) throw new Error('missing group reservation')
    if (event.type === 'group/model-dispatched') {
      if (reservation.status !== 'reserved') throw new Error('duplicate group dispatch')
      reservation.status = 'dispatched'
    } else if (event.type === 'group/reservation-released') {
      if (!['reserved', 'dispatched'].includes(reservation.status)) throw new Error('invalid group release')
      reservation.status = 'released'
    } else if (event.type === 'group/usage-unknown') {
      if (reservation.status !== 'dispatched') throw new Error('invalid unknown group usage')
      reservation.status = 'unknown'; this.#abort.abort()
    } else if (event.type === 'group/budget-settled') {
      if (reservation.status !== 'dispatched' || !validUsage(event.data.usage) || event.data.usage.source !== 'provider' || event.data.usage.uncertain) throw new Error('invalid group settlement')
      reservation.status = 'settled'; reservation.usage = structuredClone(event.data.usage)
      if (event.data.overrun) { this.#overrun = true; this.#abort.abort() }
    }
  }
  snapshot() {
    const requests = [...this.#reservations.values()].filter(item => item.status !== 'released')
    const spent = (item: Reservation) => item.usage?.totalTokens ?? item.reserve
    return { ...structuredClone(this.start), requests: requests.length, tools: this.#tools.size,
      settledTokens: requests.reduce((sum, item) => sum + (item.usage?.totalTokens ?? 0), 0), outstandingTokens: requests.filter(item => !item.usage).reduce((sum, item) => sum + item.reserve, 0),
      rootRequests: requests.filter(item => item.root).length, rootTokens: requests.filter(item => item.root).reduce((sum, item) => sum + spent(item), 0),
      usageUnknown: requests.some(item => item.status === 'unknown'), overrun: this.#overrun }
  }
  #check() {
    const state = this.snapshot()
    if (state.usageUnknown) throw new ModelNotDispatchedError('task group has unknown provider usage', 'usage_unknown')
    if (state.overrun || this.now() >= this.start.deadline) throw new ModelNotDispatchedError('task group token overrun or wall deadline', 'other_limit')
    return state
  }
  async reserve(reservation: GroupReservation) {
    return this.#serial(async () => {
      const state = this.#check(), policy = this.start.policy
      if (this.#reservations.has(reservation.requestId)) throw new ModelNotDispatchedError('request already admitted; explicit recovery required', 'other_limit')
      if (!Number.isSafeInteger(reservation.reserve) || reservation.reserve < 1) throw new ModelNotDispatchedError('invalid group reservation', 'other_limit')
      const floorRequests = reservation.root ? 0 : Math.max(0, policy.rootRequestFloor - state.rootRequests)
      const floorTokens = reservation.root ? 0 : Math.max(0, policy.rootTokenFloor - state.rootTokens)
      if (state.requests + 1 + floorRequests > policy.maxModelRequests) throw new ModelNotDispatchedError('task group request limit', 'request_limit')
      if (state.settledTokens + state.outstandingTokens + reservation.reserve + floorTokens > policy.maxTotalTokens) throw new ModelNotDispatchedError('task group token reservation limit', 'other_limit')
      await this.#persist({ type: 'group/budget-reserved', data: { ...reservation, groupId: this.start.groupId } })
    })
  }
  async dispatched(requestId: string) { return this.#serial(async () => { this.#check(); await this.#persist({ type: 'group/model-dispatched', data: { groupId: this.start.groupId, requestId } }) }) }
  async release(requestId: string) { return this.#serial(() => this.#persist({ type: 'group/reservation-released', data: { groupId: this.start.groupId, requestId } })) }
  async settle(requestId: string, usage?: Usage) {
    return this.#serial(async () => {
      const reservation = this.#reservations.get(requestId)
      if (!reservation) throw new Error('unknown group request')
      if (reservation.status === 'settled') {
        if (JSON.stringify(reservation.usage) !== JSON.stringify(usage)) throw new Error('conflicting duplicate provider usage')
        return
      }
      if (reservation.status === 'unknown') return
      if (!usage || !validUsage(usage) || usage.source !== 'provider' || usage.uncertain) {
        await this.#persist({ type: 'group/usage-unknown', data: { groupId: this.start.groupId, requestId } }); return
      }
      const overrun = usage.totalTokens > reservation.reserve
      await this.#persist({ type: 'group/budget-settled', data: { groupId: this.start.groupId, requestId, usage, overrun } })
    })
  }
  async admitTool(data: Omit<EventData['group/tool-admitted'], 'groupId'>) {
    return this.#serial(async () => {
      this.#check()
      if (this.#tools.has(data.key)) throw new Error('tool already admitted; recovery must not execute it again')
      if (this.#tools.size >= this.start.policy.maxToolCalls) throw new Error('task group tool limit')
      await this.#persist({ type: 'group/tool-admitted', data: { ...data, groupId: this.start.groupId } })
    })
  }
  async dispatch(request: ChatRequest, identity: { agentId: string; root: boolean }, invoke: (request: ChatRequest) => Promise<ChatResponse>) {
    const scope = request.dispatchScope
    if (!scope) throw new ModelNotDispatchedError('group model request requires explicit scope', 'other_limit')
    request.signal?.throwIfAborted()
    const input = estimateInput(request), reserve = input + Math.max(2048, Math.ceil(input * 0.1)) + (request.maxOutputTokens ?? 16384)
    await this.reserve({ ...scope, ...identity, purpose: request.purpose ?? 'main', reserve })
    try { await this.dispatched(scope.requestId) } catch (error) { await this.release(scope.requestId); throw error }
    const signal = AbortSignal.any([this.#abort.signal, AbortSignal.timeout(Math.max(1, this.start.deadline - this.now())), ...(request.signal ? [request.signal] : [])])
    try {
      const response = await invoke({ ...request, signal })
      await this.settle(scope.requestId, response.usage)
      const state = this.snapshot()
      if (state.usageUnknown || state.overrun) throw new ModelStreamError('group usage is unknown or exceeded its reservation', { ...response, complete: false })
      return response
    } catch (error) {
      const status = this.#reservations.get(scope.requestId)?.status
      if (status === 'dispatched') {
        if (error instanceof ModelNotDispatchedError) await this.release(scope.requestId)
        else await this.settle(scope.requestId, error instanceof ModelStreamError ? error.partial.usage : undefined)
      }
      throw error
    }
  }
}
