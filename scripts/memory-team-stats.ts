import type { SessionEvent } from '../src/core/contracts.js'
import type { Usage } from '../src/core/budget.js'

// Every number here is derived from durable events, not from the model's own
// summary. Root requests, retries, summaries and child requests are all settled
// by the same task-group ledger, so the totals cannot grow with agent count.
export interface UsageBucket { requests: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; totalTokens: number; costUsd: number; unknownRequests: number }
export interface PhaseAccounting {
  phase: 'prepare' | 'goal' | 'unknown'; taskId?: string; status?: string
  root: UsageBucket; summary: UsageBucket; child: UsageBucket; total: UsageBucket
  tools: number; retries: number; retryFailedTokens: number
  memoryQueries: number; memoryHits: number; memoryFiltered: Record<string, number>
  summariesApplied: number; summariesDeclined: number
  delegationBatches: number
  activeDurationMs: number
}
export interface MemoryTeamAccounting {
  phases: PhaseAccounting[]
  total: UsageBucket
  child: UsageBucket
  summary: UsageBucket
  retryRequests: number
  retryFailedTokens: number
  retryCostUsd: number
  retryFailedRequests: number
  unknownUsage: boolean
  overrun: boolean
  tools: number
  modelRequests: number
  memory: { queries: number; hits: number; filtered: Record<string, number>; viewEvents: number }
  delegation: { batches: number; childrenCreated: number; childSessions: number; statuses: Record<string, number>; resultBytes: number }
  summaries: { applied: number; declined: number; pressure: number }
  activeDurationMs: number
  rootActiveDurationMs: number
  childActiveDurationMs: number
}
export interface Price { inputPerMillion: number; outputPerMillion: number; cacheReadPerMillion: number }

const emptyBucket = (): UsageBucket => ({ requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0, costUsd: 0, unknownRequests: 0 })
const addUsage = (bucket: UsageBucket, usage: Usage, price: Price) => {
  bucket.requests += 1
  bucket.inputTokens += usage.inputTokens
  bucket.outputTokens += usage.outputTokens
  bucket.cacheReadTokens += usage.cacheReadTokens ?? 0
  bucket.totalTokens += usage.totalTokens
  bucket.costUsd += usageCost(usage, price)
}
export function usageCost(usage: Usage, price: Price) {
  const cached = usage.cacheReadTokens ?? 0
  return ((usage.inputTokens - cached) * price.inputPerMillion + cached * price.cacheReadPerMillion + usage.outputTokens * price.outputPerMillion) / 1_000_000
}
const addBuckets = (...buckets: UsageBucket[]): UsageBucket => buckets.reduce((sum, bucket) => ({
  requests: sum.requests + bucket.requests, inputTokens: sum.inputTokens + bucket.inputTokens, outputTokens: sum.outputTokens + bucket.outputTokens,
  cacheReadTokens: sum.cacheReadTokens + bucket.cacheReadTokens, totalTokens: sum.totalTokens + bucket.totalTokens,
  costUsd: sum.costUsd + bucket.costUsd, unknownRequests: sum.unknownRequests + bucket.unknownRequests,
}), emptyBucket())
const zeroFiltered = (): Record<string, number> => ({})
const addFiltered = (target: Record<string, number>, source: Record<string, number>) => { for (const [key, value] of Object.entries(source)) target[key] = (target[key] ?? 0) + value }

export function deriveMemoryTeamAccounting(rootEvents: readonly SessionEvent[], childEvents: readonly SessionEvent[][], price: Price): MemoryTeamAccounting {
  const phaseByTask = new Map<string, PhaseAccounting['phase']>()
  let runIndex = 0
  for (const event of rootEvents) if (event.type === 'run/start' && !phaseByTask.has(event.data.state.taskId)) {
    phaseByTask.set(event.data.state.taskId, runIndex === 0 ? 'prepare' : runIndex === 1 ? 'goal' : 'unknown'); runIndex += 1
  }
  const phases = new Map<PhaseAccounting['phase'], PhaseAccounting>()
  for (const phase of ['prepare', 'goal', 'unknown'] as const) phases.set(phase, {
    phase, root: emptyBucket(), summary: emptyBucket(), child: emptyBucket(), total: emptyBucket(),
    tools: 0, retries: 0, retryFailedTokens: 0, memoryQueries: 0, memoryHits: 0, memoryFiltered: zeroFiltered(),
    summariesApplied: 0, summariesDeclined: 0, delegationBatches: 0, activeDurationMs: 0,
  })
  const phaseFor = (taskId: string | undefined, fallback: PhaseAccounting['phase'] = 'unknown') => taskId ? phaseByTask.get(taskId) ?? fallback : fallback

  type Reservation = { phase: PhaseAccounting['phase']; root: boolean; purpose: 'main' | 'summary'; released: boolean; usage?: Usage; unknown: boolean }
  const reservations = new Map<string, Reservation>()
  for (const event of rootEvents) {
    if (event.type === 'group/budget-reserved') reservations.set(event.data.requestId, {
      phase: phaseFor(event.taskId), root: event.data.root, purpose: event.data.purpose, released: false, unknown: false,
    })
    else if (event.type === 'group/reservation-released' && reservations.has(event.data.requestId)) reservations.get(event.data.requestId)!.released = true
    else if (event.type === 'group/usage-unknown' && reservations.has(event.data.requestId)) reservations.get(event.data.requestId)!.unknown = true
    else if (event.type === 'group/budget-settled' && reservations.has(event.data.requestId)) reservations.get(event.data.requestId)!.usage = event.data.usage
  }
  const retried = new Set<string>()
  for (const event of rootEvents) if (event.type === 'model/retry') retried.add(event.data.failedRequestId)

  const childPhase = new Map<string, PhaseAccounting['phase']>()
  for (const event of rootEvents) {
    if (event.type === 'delegation/child-created') childPhase.set(event.data.childSessionId, phaseFor(event.taskId))
    if (event.type === 'delegation/start') phases.get(phaseFor(event.taskId))!.delegationBatches += 1
    if (event.type === 'memory/query') {
      const phase = phases.get(phaseFor(event.taskId))!, items = event.data.items.length
      phase.memoryQueries += 1; phase.memoryHits += items; addFiltered(phase.memoryFiltered, event.data.filtered)
    }
    if (event.type === 'context/summary-end') {
      const phase = phases.get(phaseFor(event.taskId))!
      if (event.data.outcome.kind === 'applied') phase.summariesApplied += 1
      else phase.summariesDeclined += 1
    }
  }
  let childActiveDurationMs = 0
  for (const events of childEvents) {
    const sessionId = events[0]?.sessionId
    if (!sessionId) continue
    const phase = phases.get(childPhase.get(sessionId) ?? 'goal')!
    for (const event of events) {
      if (event.type === 'tool/start') phase.tools += 1
      if (event.type === 'memory/query') {
        phase.memoryQueries += 1; phase.memoryHits += event.data.items.length; addFiltered(phase.memoryFiltered, event.data.filtered)
      }
      if (event.type === 'model/retry') phase.retries += 1
      if (event.type === 'run/finish') {
        const active = event.data.state.counters.activeDurationMs
        phase.activeDurationMs += active; childActiveDurationMs += active
      }
    }
  }
  let unknownUsage = false, overrun = false, modelRequests = 0, tools = 0
  for (const event of rootEvents) {
    if (event.type === 'tool/start') { phases.get(phaseFor(event.taskId))!.tools += 1; tools += 1 }
    if (event.type === 'model/start') modelRequests += 1
    if (event.type === 'model/retry') phases.get(phaseFor(event.taskId))!.retries += 1
    if (event.type === 'group/usage-unknown') unknownUsage = true
    if (event.type === 'group/budget-settled' && event.data.overrun) overrun = true
    if (event.type === 'run/finish') phases.get(phaseFor(event.taskId))!.activeDurationMs += event.data.state.counters.activeDurationMs
  }
  for (const events of childEvents) for (const event of events) {
    if (event.type === 'model/start') modelRequests += 1
    if (event.type === 'tool/start') tools += 1
  }

  const total = emptyBucket()
  for (const reservation of reservations.values()) {
    if (reservation.released) continue
    const phase = phases.get(reservation.phase)!
    if (reservation.unknown) {
      phase.total.unknownRequests += 1; unknownUsage = true
      if (reservation.root && reservation.purpose === 'summary') phase.summary.unknownRequests += 1
      else if (reservation.root) phase.root.unknownRequests += 1
      else phase.child.unknownRequests += 1
      continue
    }
    if (!reservation.usage) continue
    const bucket = reservation.purpose === 'summary' ? phase.summary : reservation.root ? phase.root : phase.child
    addUsage(bucket, reservation.usage, price)
    addUsage(phase.total, reservation.usage, price)
    addUsage(total, reservation.usage, price)
  }
  let retryCount = 0, retryFailedRequests = 0, retryFailedTokens = 0, retryCostUsd = 0
  for (const [requestId, reservation] of reservations) {
    if (reservation.released || !retried.has(requestId)) continue
    retryFailedRequests += 1
    if (reservation.usage) {
      retryFailedTokens += reservation.usage.totalTokens; retryCostUsd += usageCost(reservation.usage, price)
      phases.get(reservation.phase)!.retryFailedTokens += reservation.usage.totalTokens
    }
  }
  for (const event of rootEvents) if (event.type === 'model/retry') retryCount += 1
  for (const events of childEvents) for (const event of events) if (event.type === 'model/retry') retryCount += 1
  const child = addBuckets(...[...phases.values()].map(phase => phase.child))
  const summary = addBuckets(...[...phases.values()].map(phase => phase.summary))
  const memory = { queries: 0, hits: 0, filtered: zeroFiltered(), viewEvents: rootEvents.filter(event => event.type === 'memory/view').length }
  const statuses: Record<string, number> = {}
  for (const phase of phases.values()) { memory.queries += phase.memoryQueries; memory.hits += phase.memoryHits; addFiltered(memory.filtered, phase.memoryFiltered) }
  for (const event of rootEvents) if (event.type === 'delegation/child-finish') statuses[event.data.status] = (statuses[event.data.status] ?? 0) + 1
  const childrenCreated = rootEvents.filter(event => event.type === 'delegation/child-created').length
  const resultBytes = rootEvents.reduce((sum, event) => sum + (event.type === 'delegation/finish' ? Buffer.byteLength(event.data.result) : 0), 0)
  const rootActiveDurationMs = [...phases.values()].reduce((sum, phase) => sum + phase.activeDurationMs, 0) - childActiveDurationMs
  return {
    phases: [...phases.values()], total, child, summary, retryRequests: retryCount, retryFailedTokens, retryCostUsd, retryFailedRequests,
    unknownUsage, overrun, tools, modelRequests, memory,
    delegation: { batches: rootEvents.filter(event => event.type === 'delegation/start').length, childrenCreated, childSessions: childEvents.length, statuses, resultBytes },
    summaries: {
      applied: rootEvents.filter(event => event.type === 'context/summary-end' && event.data.outcome.kind === 'applied').length,
      declined: rootEvents.filter(event => event.type === 'context/summary-end' && event.data.outcome.kind !== 'applied').length,
      pressure: rootEvents.filter(event => event.type === 'context/summary-start' && event.data.trigger === 'pressure').length,
    },
    activeDurationMs: rootActiveDurationMs + childActiveDurationMs, rootActiveDurationMs, childActiveDurationMs,
  }
}
