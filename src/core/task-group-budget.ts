import { randomUUID } from 'node:crypto'
import { estimateInput } from './token-estimator.js'
import { validUsage } from './event-validation.js'
import { ModelNotDispatchedError } from './model-dispatch.js'
import { ModelStreamError, ProviderError } from './model-error.js'
import type { ChatRequest, ChatResponse, EventData } from './contracts.js'
import type { SessionRuntime } from './session-runtime.js'
import type { Usage } from './budget.js'

export interface TaskGroupPolicy { maxModelRequests: number; maxToolCalls: number; maxTotalTokens: number; rootTokenFloor: number; rootRequestFloor: number; maxWallDurationMs: number; maxInFlightRequests: number }
// maxInFlightRequests = 0 表示不额外限制（会话委派的既有行为）；编排根组按 maxWorkers + 1 设置。
export const TASK_GROUP_POLICY: Readonly<TaskGroupPolicy> = Object.freeze({ maxModelRequests: 64, maxToolCalls: 128, maxTotalTokens: 2_000_000, rootTokenFloor: 1_000_000, rootRequestFloor: 32, maxWallDurationMs: 900_000, maxInFlightRequests: 0 })
export interface DispatchScope { sessionId: string; taskId: string; runId: string; requestId: string }
export interface GroupReservation extends DispatchScope { agentId: string; root: boolean; purpose: 'main' | 'summary'; reserve: number }
export interface GroupStart { groupId: string; policy: TaskGroupPolicy; deadline: number }
export type GroupBudgetEvent =
  | { type: 'group/start'; data: GroupStart }
  | { type: 'group/budget-reserved'; data: GroupReservation & { groupId: string } }
  | { type: 'group/model-dispatched' | 'group/reservation-released'; data: { groupId: string; requestId: string } }
  | { type: 'group/usage-unknown'; data: { groupId: string; requestId: string; cause?: 'crash' | 'cancel' | 'no_usage' } }
  | { type: 'group/budget-settled'; data: { groupId: string; requestId: string; usage: Usage; overrun: boolean } }
  | { type: 'group/tool-admitted'; data: { groupId: string; key: string; agentId: string; sessionId: string; runId: string; toolCallId: string } }
type Reservation = GroupReservation & { status: 'reserved' | 'dispatched' | 'released' | 'settled' | 'unknown'; usage?: Usage; cause?: 'crash' | 'cancel' | 'no_usage' }
type Sessions = Pick<SessionRuntime, 'get' | 'latestRun' | 'append' | 'flush'>
// 任务组事件的持久化位置：会话日志（单 Agent 委派）或独立的编排日志（多 Agent 编排）。
// append 返回时必须已落盘；read 只返回本组已可见的 group/* 事件。
export interface GroupJournal {
  read(): readonly GroupBudgetEvent[]
  append(event: GroupBudgetEvent): Promise<void>
}
export class SessionGroupJournal implements GroupJournal {
  constructor(readonly sessions: Sessions, readonly rootSessionId: string, readonly rootTaskId: string) {}
  read() { return this.sessions.get(this.rootSessionId).events.filter(event => event.taskId === this.rootTaskId && event.type.startsWith('group/')) as unknown as GroupBudgetEvent[] }
  #scope() {
    const state = this.sessions.latestRun(this.rootSessionId)
    if (state?.taskId === this.rootTaskId) return state
    const original = [...this.sessions.get(this.rootSessionId).events].reverse().find(event => event.type === 'run/start' && event.taskId === this.rootTaskId)
    if (original?.type !== 'run/start') throw new Error('root task scope is unavailable')
    return original.data.state
  }
  async append(event: GroupBudgetEvent) { this.sessions.append(this.rootSessionId, event.type, event.data, this.#scope()); await this.sessions.flush(this.rootSessionId) }
}
export function groupPolicy(overrides: Partial<TaskGroupPolicy> = {}): Readonly<TaskGroupPolicy> {
  const policy = { ...TASK_GROUP_POLICY, ...overrides }
  for (const [key, value] of Object.entries(policy)) if (!(key in TASK_GROUP_POLICY) || !Number.isSafeInteger(value) || value < (key === 'maxWallDurationMs' ? 1 : 0)) throw new Error(`invalid task group policy: ${key}`)
  if (policy.rootTokenFloor > policy.maxTotalTokens || policy.rootRequestFloor > policy.maxModelRequests || policy.maxWallDurationMs > 2_147_483_647) throw new Error('invalid root floor or group duration')
  if (policy.maxInFlightRequests > 64) throw new Error('invalid task group in-flight limit')
  return Object.freeze(policy)
}
export type GroupCooldownWait = (ms: number) => Promise<void>
export class TaskGroupBudgetCoordinator {
  #queue: Promise<void> = Promise.resolve()
  #reservations = new Map<string, Reservation>()
  #tools = new Set<string>()
  #failure: unknown
  #overrun = false
  #acceptedUnknown = false
  #crashed = false
  #cooldownUntil = 0
  #abort = new AbortController()
  #signal?: AbortSignal
  readonly start: GroupStart
  private constructor(readonly journal: GroupJournal, start: GroupStart, private now: () => number, private wait?: GroupCooldownWait) { this.start = Object.freeze({ ...start, policy: groupPolicy(start.policy) }) }
  static open(sessions: Sessions, rootSessionId: string, rootTaskId: string, overrides: Partial<TaskGroupPolicy> = {}, now = Date.now) {
    return TaskGroupBudgetCoordinator.openJournal(new SessionGroupJournal(sessions, rootSessionId, rootTaskId), overrides, now)
  }
  static async openJournal(journal: GroupJournal, overrides: Partial<TaskGroupPolicy> = {}, now = Date.now, wait?: GroupCooldownWait) {
    const events = journal.read()
    const saved = events.find(event => event.type === 'group/start')
    const start: GroupStart = saved?.type === 'group/start' ? saved.data : { groupId: randomUUID(), policy: { ...groupPolicy(overrides) }, deadline: now() + groupPolicy(overrides).maxWallDurationMs }
    const group = new TaskGroupBudgetCoordinator(journal, start, now, wait)
    if (!saved) await group.#persist({ type: 'group/start', data: start })
    else for (const event of events) group.#fold(event)
    // Crash before a durable dispatch intent: release. After intent: retain the reservation as unknown.
    for (const [requestId, reservation] of group.#reservations) {
      if (reservation.status === 'reserved') await group.#persist({ type: 'group/reservation-released', data: { groupId: start.groupId, requestId } })
      if (reservation.status === 'dispatched') await group.#persist({ type: 'group/usage-unknown', data: { groupId: start.groupId, requestId, cause: 'crash' } })
    }
    return group
  }
  // 人工确认崩溃/无 usage 的未知预留后，允许后续派发；未知量仍按预留额计入总量，
  // 取消产生的未知量本来就不阻断。
  acceptUnknownUsage() {
    this.#acceptedUnknown = true
    this.#abort = new AbortController()
    this.#signal = undefined
  }
  // 429 冷却由根组共享：所有 worker 的下一次派发都等待到同一时间点。
  noteRateLimit(retryAfterMs?: number) {
    this.#cooldownUntil = Math.max(this.#cooldownUntil, this.now() + Math.max(retryAfterMs ?? 0, 2_000))
  }
  // 编排器的进程内崩溃注入在 abort 兄弟 worker 前调用；之后被中止的在途调用按 crash 记账，
  // 而不是用户取消，恢复时才需要人工确认。
  markCrashed() { this.#crashed = true }
  #serial<T>(work: () => Promise<T>) {
    const operation = this.#queue.then(async () => { if (this.#failure) throw new Error('group persistence failed', { cause: this.#failure }); return work() })
    this.#queue = operation.then(() => {}, () => {}); return operation
  }
  async #persist(event: GroupBudgetEvent) {
    try { await this.journal.append(event) }
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
      reservation.status = 'unknown'
      reservation.cause = event.data.cause ?? 'no_usage'
      // 取消时 provider 已返回但 usage 未知，不代表账本失真；只有 crash/no_usage 需要中止并人工确认。
      if (reservation.cause !== 'cancel') this.#abort.abort()
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
      usageUnknown: requests.some(item => item.status === 'unknown'),
      blockingUnknown: requests.some(item => item.status === 'unknown' && item.cause !== 'cancel'),
      acceptedUnknown: this.#acceptedUnknown, cooldownUntil: this.#cooldownUntil, overrun: this.#overrun }
  }
  get signal() {
    this.#signal ??= AbortSignal.any([this.#abort.signal, AbortSignal.timeout(Math.max(1, this.start.deadline - this.now()))])
    return this.#signal
  }
  get stopReason(): 'timeout' | 'token_budget' | 'error' | undefined {
    if (this.now() >= this.start.deadline) return 'timeout'
    if (this.#overrun) return 'token_budget'
    const state = this.snapshot()
    if (this.#failure || (state.blockingUnknown && !this.#acceptedUnknown)) return 'error'
    return undefined
  }
  #check() {
    const state = this.snapshot()
    if (state.blockingUnknown && !this.#acceptedUnknown) throw new ModelNotDispatchedError('task group has unknown provider usage', 'usage_unknown')
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
      // 在途上限按“已预留或已派发、尚未结清”计：预留到派发之间的窗口也占名额，否则并发 dispatch 会同时越过上限。
      if (policy.maxInFlightRequests > 0) {
        const inFlight = [...this.#reservations.values()].filter(item => item.status === 'reserved' || item.status === 'dispatched').length
        if (inFlight >= policy.maxInFlightRequests) throw new ModelNotDispatchedError('task group in-flight request limit', 'request_limit')
      }
      if (state.requests + 1 + floorRequests > policy.maxModelRequests) throw new ModelNotDispatchedError('task group request limit', 'request_limit')
      if (state.settledTokens + state.outstandingTokens + reservation.reserve + floorTokens > policy.maxTotalTokens) throw new ModelNotDispatchedError('task group token reservation limit', 'other_limit')
      await this.#persist({ type: 'group/budget-reserved', data: { ...reservation, groupId: this.start.groupId } })
    })
  }
  async dispatched(requestId: string) { return this.#serial(async () => {
    this.#check()
    if (this.#reservations.get(requestId)?.status !== 'reserved') throw new Error('group dispatch requires a reserved request')
    await this.#persist({ type: 'group/model-dispatched', data: { groupId: this.start.groupId, requestId } })
  }) }
  async release(requestId: string) { return this.#serial(async () => {
    if (!['reserved', 'dispatched'].includes(this.#reservations.get(requestId)?.status ?? '')) throw new Error('group release requires an outstanding request')
    await this.#persist({ type: 'group/reservation-released', data: { groupId: this.start.groupId, requestId } })
  }) }
  async settle(requestId: string, usage?: Usage, cause: 'crash' | 'cancel' | 'no_usage' = 'no_usage') {
    return this.#serial(async () => {
      const reservation = this.#reservations.get(requestId)
      if (!reservation) throw new Error('unknown group request')
      if (reservation.status === 'settled') {
        if (JSON.stringify(reservation.usage) !== JSON.stringify(usage)) throw new Error('conflicting duplicate provider usage')
        return
      }
      if (reservation.status === 'unknown') return
      if (reservation.status !== 'dispatched') throw new Error('group settlement requires a dispatched request')
      if (!usage || !validUsage(usage) || usage.source !== 'provider' || usage.uncertain) {
        await this.#persist({ type: 'group/usage-unknown', data: { groupId: this.start.groupId, requestId, cause } }); return
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
  async #waitCooldown(signal: AbortSignal) {
    const remaining = this.#cooldownUntil - this.now()
    if (remaining <= 0) return
    if (this.wait) { await this.wait(remaining); signal.throwIfAborted(); return }
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(new ModelNotDispatchedError('cancelled during rate-limit cooldown', 'other_limit')) }
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, remaining)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
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
    if (signal.aborted) { await this.release(scope.requestId); throw new ModelNotDispatchedError('cancelled before provider invocation', 'other_limit') }
    try { await this.#waitCooldown(signal) } catch (error) { await this.release(scope.requestId); throw error }
    try {
      const response = await new Promise<ChatResponse>((resolve, reject) => {
        const abort = () => reject(new ModelStreamError('group request cancelled; provider usage unknown', { complete: false }))
        signal.addEventListener('abort', abort, { once: true })
        void invoke({ ...request, signal }).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort)).catch(() => {})
      })
      await this.settle(scope.requestId, response.usage)
      const state = this.snapshot()
      if (state.blockingUnknown && !state.acceptedUnknown || state.overrun) throw new ModelStreamError('group usage is unknown or exceeded its reservation', { ...response, complete: false })
      return response
    } catch (error) {
      const rateLimited = error instanceof ProviderError && error.kind === 'rate_limit'
      if (rateLimited) this.noteRateLimit((error as ProviderError).retryAfterMs)
      const status = this.#reservations.get(scope.requestId)?.status
      if (status === 'dispatched') {
        // 进程内模拟崩溃用 name=SimulatedCrash 的 abort reason 区分于用户取消：
        // 两者都没有可信 usage，但只有崩溃需要在恢复时人工确认。
        const crashed = this.#crashed || signal.aborted && (signal.reason as { name?: unknown } | undefined)?.name === 'SimulatedCrash'
        // provider 明确以 429 拒绝时没有可计费用量：释放预留，让 Loop 的退避重试在冷却后继续。
        if (error instanceof ModelNotDispatchedError || rateLimited) await this.release(scope.requestId)
        else await this.settle(scope.requestId, error instanceof ModelStreamError ? error.partial.usage : undefined, crashed ? 'crash' : signal.aborted ? 'cancel' : 'no_usage')
      }
      throw error
    }
  }
}
