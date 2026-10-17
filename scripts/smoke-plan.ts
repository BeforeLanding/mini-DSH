import { CLI_BUDGET, type BudgetPolicy } from '../src/core/budget.js'

export type SmokeId = 'protocol' | 'recall' | 'repair'
export interface SmokeScenario {
  id: SmokeId
  maxMainRequests: number
  maxSummaryRequests: number
  maxTotalTokens: number
  maxOutputTokens: number
  maxSummaryOutputTokens: number
  maxActiveDurationMs: number
  maxWallDurationMs: number
  requestTimeoutMs: number
  maxToolCalls: number
  fixture: 'synthetic-protocol' | 'synthetic-history' | 'coding-repair'
}

// These are smoke safety limits, not benchmark arms. Context/compaction ratios,
// prompt layout and thinking remain at the NX-43 production settings.
export const smokeScenarios: readonly SmokeScenario[] = Object.freeze([
  { id: 'protocol', maxMainRequests: 2, maxSummaryRequests: 0, maxTotalTokens: 20_000, maxOutputTokens: 1_024, maxSummaryOutputTokens: 0, maxActiveDurationMs: 120_000, maxWallDurationMs: 150_000, requestTimeoutMs: 60_000, maxToolCalls: 0, fixture: 'synthetic-protocol' },
  { id: 'recall', maxMainRequests: 4, maxSummaryRequests: 1, maxTotalTokens: 300_000, maxOutputTokens: 16_384, maxSummaryOutputTokens: 8_192, maxActiveDurationMs: 600_000, maxWallDurationMs: 660_000, requestTimeoutMs: 180_000, maxToolCalls: 16, fixture: 'synthetic-history' },
  { id: 'repair', maxMainRequests: 6, maxSummaryRequests: 1, maxTotalTokens: 200_000, maxOutputTokens: 16_384, maxSummaryOutputTokens: 8_192, maxActiveDurationMs: 600_000, maxWallDurationMs: 660_000, requestTimeoutMs: 180_000, maxToolCalls: 32, fixture: 'coding-repair' },
])

export function smokeBudget(scenario: SmokeScenario): Readonly<BudgetPolicy> {
  return { ...CLI_BUDGET, contextWindowTokens: 1_000_000,
    maxModelRequests: scenario.maxMainRequests + scenario.maxSummaryRequests,
    maxToolCalls: scenario.maxToolCalls, maxTotalTokens: scenario.maxTotalTokens,
    maxOutputTokens: scenario.maxOutputTokens, minimumOutputTokens: Math.min(CLI_BUDGET.minimumOutputTokens!, scenario.maxOutputTokens), maxActiveDurationMs: scenario.maxActiveDurationMs,
    requestTimeoutMs: scenario.requestTimeoutMs }
}

export const smokeTotalRequests = smokeScenarios.reduce((sum, item) => sum + item.maxMainRequests + item.maxSummaryRequests, 0)
export const smokeTotalTokens = smokeScenarios.reduce((sum, item) => sum + item.maxTotalTokens, 0)
