import { ModelStreamError } from '../src/core/model-error.js'
import { ModelNotDispatchedError } from '../src/core/model-dispatch.js'
import type { Adapter } from '../src/core/contracts.js'
import type { Usage } from '../src/core/budget.js'
import type { SmokeManifest } from './smoke-manifest.js'
import { smokeBudget, type SmokeScenario } from './smoke-plan.js'

type Price = SmokeManifest['price']
export function smokeReserveUsd(selected: readonly SmokeScenario[], price: Price) {
  const maxRate = Math.max(price.peakCacheReadPerMillion, price.peakInputPerMillion, price.peakOutputPerMillion)
  const tokenBudgetUsd = selected.reduce((sum, item) => sum + item.maxTotalTokens * maxRate / 1_000_000, 0)
  const marginUsd = tokenBudgetUsd * 0.2
  const finalRequestUsd = selected.reduce((sum, item) => {
    const contextTokens = smokeBudget(item).contextWindowTokens!
    const outputs = [item.maxMainRequests > 0 ? item.maxOutputTokens : 0, item.maxSummaryRequests > 0 ? item.maxSummaryOutputTokens : 0]
    return sum + contextTokens * price.peakInputPerMillion / 1_000_000 + Math.max(...outputs) * price.peakOutputPerMillion / 1_000_000
  }, 0)
  return { tokenBudgetUsd, marginUsd, finalRequestUsd, reserveUsd: tokenBudgetUsd + marginUsd + finalRequestUsd }
}
export function peakUsageUsd(usage: Usage, price: Price) {
  const cached = usage.cacheReadTokens ?? 0
  if (usage.source !== 'provider' || !Number.isSafeInteger(cached) || cached < 0 || cached > usage.inputTokens) throw new Error('smoke price requires valid provider usage')
  return ((usage.inputTokens - cached) * price.peakInputPerMillion + cached * price.peakCacheReadPerMillion + usage.outputTokens * price.peakOutputPerMillion) / 1_000_000
}

// Reserve the largest single request admitted by the frozen 1M context and
// per-request output ceiling before dispatch. A missing usage result stops all
// further calls rather than being silently charged as zero.
export function createSmokeAmountGuard(delegate: Adapter['chat'], price: Price, maxUsd: number) {
  let spentUsd = 0
  let usageUnknown = false
  let calls = 0
  const chat: Adapter['chat'] = async request => {
    if (usageUnknown) throw new ModelNotDispatchedError('smoke usage unknown; no further provider call made', 'usage_unknown')
    if (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens! <= 0) throw new ModelNotDispatchedError('smoke amount guard requires output ceiling', 'other_limit')
    const reserve = price.peakInputPerMillion + request.maxOutputTokens! * price.peakOutputPerMillion / 1_000_000
    if (spentUsd + reserve > maxUsd) throw new ModelNotDispatchedError('smoke amount ceiling cannot reserve the next request; no provider call made', 'amount_limit')
    calls++
    try {
      const response = await delegate(request)
      if (response.usage?.source !== 'provider') usageUnknown = true
      else spentUsd += peakUsageUsd(response.usage, price)
      return response
    } catch (error) {
      if (error instanceof ModelNotDispatchedError) { calls--; throw error }
      const partial = error instanceof ModelStreamError ? error.partial : undefined
      if (partial?.usage?.source === 'provider') spentUsd += peakUsageUsd(partial.usage, price)
      else usageUnknown = true
      throw error
    }
  }
  return { chat, get spentUsd() { return spentUsd }, get usageUnknown() { return usageUnknown }, get calls() { return calls } }
}
