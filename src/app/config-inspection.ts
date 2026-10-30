import { CLI_BUDGET, resolveBudget } from '../core/budget.js'
import { isRecord } from '../core/event-store.js'
import { deepSeekModelMetadata } from '../models/deepseek.js'
import { createHarness } from './create-harness.js'
import { describeMcpConfig } from './mcp-config.js'
import { productionHarnessConfig } from './production-config.js'

type Source = 'environment' | '.env' | 'default'
type Origin = (key: string) => Source

// show-config 不连接 MCP：createHarness 不传 mcpServers，配置只用 describeMcpConfig 读取结构，
// 因此这里也不会展开 header/env 的值，只列出变量名与缺失项。
export async function inspectProductionConfig(env: NodeJS.ProcessEnv, origin: Origin = () => 'environment', cwd = process.cwd(), options: { mcpConfigPath?: string } = {}) {
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
  const mcp = await describeMcpConfig({ env, ...(options.mcpConfigPath ? { configPath: options.mcpConfigPath } : {}) })
  const harness = await createHarness(config)
  try {
    const configured = (key: string) => env[key] === undefined ? 'default' : origin(key)
    return {
      scope: 'new session; no provider or CLI session started',
      model: { value: model, source: configured('MINI_DSH_MODEL') },
      workspace: { value: harness.root.sandbox.workspace, source: configured('MINI_DSH_WORKSPACE') },
      profile: { value: config.profile, source: configured('MINI_DSH_PROFILE') },
      contextLayout: { value: config.contextLayout, source: configured('MINI_DSH_CONTEXT_LAYOUT') },
      runtimeClockMode: { value: config.runtimeClockMode, source: env.MINI_DSH_RUNTIME_TIME_MODE !== undefined
        ? origin('MINI_DSH_RUNTIME_TIME_MODE') : env.MINI_DSH_CONTEXT_LAYOUT !== undefined ? origin('MINI_DSH_CONTEXT_LAYOUT') : 'default' },
      projectContext: { enabled: config.profile === 'coding', directory: config.projectDirectory ?? '.', source: configured('MINI_DSH_PROJECT_DIRECTORY') },
      toolResultPreviewBytes: { value: config.toolOutputMaxPreviewBytes ?? 16_384, source: configured('MINI_DSH_TOOL_PREVIEW_BYTES') },
      readHistory: { enabled: harness.capabilityManifest.tools.includes('read_history'), source: 'createHarness' },
      autoApprove: { value: env.MINI_DSH_AUTO_APPROVE === '1', source: configured('MINI_DSH_AUTO_APPROVE') },
      budget: { effective: budget, sources: budgetSources, activeCompactionBudgetTokens: budget.compactionBudgetTokens ?? budget.inputTargetTokens,
        overflowFallbackRetries: budget.maxOverflowRetries },
      tools: harness.capabilityManifest.tools,
      mcp,
    }
  } finally { await harness.dispose() }
}
