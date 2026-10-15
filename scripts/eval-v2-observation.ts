import type { SessionEvent } from '../src/core/contracts.js'
import { validatePayload } from '../src/core/event-validation.js'
import type { RunOutcome } from './eval-runner.js'
import type { V2Episode } from './eval-v2-plan.js'
import type { V2Observation } from './eval-v2-report.js'

// A semantically invalid journal must fail acceptance, but its already-billed
// provider usage must not disappear from the amount ledger. This parser only
// recovers individually valid lines; it never makes the episode admissible.
export function recoverV2UnverifiedEvents(raw: string): SessionEvent[] {
  const events: SessionEvent[] = []
  const usageRequests = new Set<string>()
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue
    try {
      const value: unknown = JSON.parse(line)
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      const event = value as Record<string, unknown>
      if (typeof event.type !== 'string' || !event.data || typeof event.data !== 'object' || Array.isArray(event.data)) continue
      validatePayload(event.type, event.data as Record<string, unknown>)
      if (event.type === 'model/usage') {
        const data = event.data as { requestId: string; usage: { inputTokens: number; cacheReadTokens?: number } }
        const cache = data.usage.cacheReadTokens ?? 0
        if (!Number.isSafeInteger(cache) || cache < 0 || cache > data.usage.inputTokens || usageRequests.has(data.requestId)) continue
        usageRequests.add(data.requestId)
      }
      events.push(value as SessionEvent)
    } catch { /* Preserve valid later usage even if one line is damaged. */ }
  }
  return events
}

export function deriveV2Observation(episode: V2Episode, outcome: RunOutcome, events: readonly SessionEvent[], evidenceComplete: boolean): V2Observation {
  const stages = outcome.tasks ?? []
  const scope = stages.length ? events.filter(event => event.runId && stages.some(stage => stage.taskId === event.taskId)) : events
  const summaryIds = new Set<string>()
  const summaryStarts = new Map<string, number>()
  const durations = new Map<string, number>()
  let pendingSummary = false
  for (const event of scope) {
    if (event.type === 'context/summary-start') pendingSummary = true
    if (event.type === 'model/start' && pendingSummary) {
      summaryIds.add(event.data.requestId)
      summaryStarts.set(event.data.requestId, Date.parse(event.at))
      pendingSummary = false
    }
    if (event.type === 'model/end' && summaryStarts.has(event.data.requestId)) durations.set(event.data.requestId, Math.max(0, Date.parse(event.at) - summaryStarts.get(event.data.requestId)!))
  }
  const usage = scope.filter(event => event.type === 'model/usage')
  const summaryTokens = usage.reduce((sum, event) => sum + (summaryIds.has(event.data.requestId) ? event.data.usage.totalTokens : 0), 0)
  const toolSkipped = scope.filter(event => event.type === 'tool/result' && event.data.status === 'skipped').length
  const prunedTaskIds = [...new Set(stages.flatMap(stage => stage.removedTaskIds))]
  const stablePromptRuns = stages.filter(stage => stage.promptRounds.rounds > 1 && stage.promptRounds.stable === stage.promptRounds.rounds - 1).length
  const acceptanceGroups = outcome.acceptance?.groups?.map(group => ({ name: group.name, passed: group.passed })) ?? []
  return {
    taskId: episode.taskId, repeat: episode.repeat, arm: episode.arm, status: outcome.status, accepted: outcome.accepted,
    acceptanceGroups, protectedFilesChanged: outcome.acceptance?.protectedFilesChanged ?? [], evidenceComplete,
    ...(outcome.error ? { failureReason: 'infrastructure' } : outcome.status !== 'completed' ? { failureReason: outcome.status } : outcome.accepted === false ? { failureReason: 'acceptance' } : {}),
    metrics: {
      mainRequests: Math.max(0, outcome.counters.modelRequests - summaryIds.size), summaryRequests: summaryIds.size,
      toolCalls: outcome.counters.toolCalls, toolErrors: outcome.counters.toolErrors, policyRejected: null, toolSkipped,
      inputTokens: outcome.counters.inputTokens, outputTokens: outcome.counters.outputTokens, summaryTokens,
      cacheReadTokens: outcome.counters.cacheReadTokens,
      providerTokens: usage.reduce((sum, event) => sum + (event.data.usage.source === 'provider' ? event.data.usage.totalTokens : 0), 0),
      estimatedTokens: usage.reduce((sum, event) => sum + (event.data.usage.source === 'estimated' ? event.data.usage.totalTokens : 0), 0),
      activeDurationMs: outcome.counters.activeDurationMs,
      requestDurationsMs: stages.flatMap(stage => stage.requestDurationsMs),
      summaryDurationMs: [...durations.values()].reduce((sum, value) => sum + value, 0),
      timeouts: outcome.status === 'timeout' ? 1 : 0,
      pressureCompactions: stages.reduce((sum, stage) => sum + stage.compactions.pressure, 0), prunedTaskIds,
      previewTruncations: outcome.counters.previewTruncations, stablePromptRuns,
      multiRoundRuns: stages.filter(stage => stage.promptRounds.rounds > 1).length,
    },
  }
}
