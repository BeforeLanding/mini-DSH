import { CLI_BUDGET, resolveBudget } from '../core/budget.js'
import { isRecord } from '../core/event-store.js'
import { deepSeekModelMetadata } from '../models/deepseek.js'
import { createHarness } from './create-harness.js'
import { productionHarnessConfig } from './production-config.js'

type Source = 'environment' | '.env' | 'default'
type Origin = (key: string) => Source

export async function inspectProductionConfig(env: NodeJS.ProcessEnv, origin: Origin = () => 'environment', cwd = process.cwd()) {
  if (env.MINI_DSH_SESSION_ID) throw new Error('--show-config shows new-session configuration; unset MINI_DSH_SESSION_ID or inspect the resumed session with /budget')
  const config = productionHarnessConfig(env, cwd)
  const modelMetadata = deepSeekModelMetadata({ baseUrl: env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com' })
  const model = env.MINI_DSH_MODEL ?? `deepseek/${modelMetadata.models[0]}`
  if (!modelMetadata.models.some(name => model === `deepseek/${name}`)) throw new Error('MINI_DSH_MODEL must name a registered DeepSeek model')
  let overrides: unknown = {}
  if (env.MINI_DSH_BUDGET !== undefined) {
    try { overrides = JSON.parse(env.MINI_DSH_BUDGET) } catch { throw new Error('MINI_DSH_BUDGET must be a JSON object') }
    if (!isRecord(overrides)) throw new Error('MINI_DSH_BUDGET must be a JSON object')
  }
  const budgetOverrides = overrides as Record<string, unknown>
  const providerCapacity = modelMetadata.contextWindowTokens === undefined ? undefined : { contextWindowTokens: modelMetadata.contextWindowTokens }
  const budget = resolveBudget(providerCapacity, CLI_BUDGET, budgetOverrides)
  const budgetSources = Object.fromEntries(Object.keys(budget).map(key => [key,
    Object.hasOwn(budgetOverrides, key) ? origin('MINI_DSH_BUDGET') : key === 'contextWindowTokens' ? 'provider capability' : 'CLI_BUDGET']))
  const harness = await createHarness(config)
  try {
    const configured = (key: string) => env[key] === undefined ? 'default' : origin(key)
    return {
      scope: 'new session; no provider or CLI session started',
      model: { value: model, source: configured('MINI_DSH_MODEL') },
      workspace: { value: harness.root.sandbox.workspace, source: configured('MINI_DSH_WORKSPACE') },
      profile: { value: config.profile, source: configured('MINI_DSH_PROFILE') },
      contextLayout: { value: config.contextLayout, source: configured('MINI_DSH_CONTEXT_LAYOUT') },
      projectContext: { enabled: config.profile === 'coding', directory: config.projectDirectory ?? '.', source: configured('MINI_DSH_PROJECT_DIRECTORY') },
      toolResultPreviewBytes: { value: config.toolOutputMaxPreviewBytes ?? 16_384, source: configured('MINI_DSH_TOOL_PREVIEW_BYTES') },
      readHistory: { enabled: harness.capabilityManifest.tools.includes('read_history'), source: 'createHarness' },
      autoApprove: { value: env.MINI_DSH_AUTO_APPROVE === '1', source: configured('MINI_DSH_AUTO_APPROVE') },
      budget: { effective: budget, sources: budgetSources, activeCompactionBudgetTokens: budget.compactionBudgetTokens ?? budget.inputTargetTokens,
        overflowFallbackRetries: budget.maxOverflowRetries },
      tools: harness.capabilityManifest.tools,
    }
  } finally { await harness.dispose() }
}
