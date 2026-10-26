import type { HarnessConfig } from './create-harness.js'

type Environment = NodeJS.ProcessEnv

export function productionHarnessConfig(env: Environment = process.env, cwd = process.cwd()): HarnessConfig {
  const profile = env.MINI_DSH_PROFILE ?? 'coding'
  if (profile !== 'general' && profile !== 'coding') throw new Error('MINI_DSH_PROFILE must be general or coding')
  const contextLayout = env.MINI_DSH_CONTEXT_LAYOUT ?? 'live'
  if (contextLayout !== 'live' && contextLayout !== 'frozen') throw new Error('MINI_DSH_CONTEXT_LAYOUT must be live or frozen')
  const runtimeClockMode = env.MINI_DSH_RUNTIME_TIME_MODE ?? (env.MINI_DSH_CONTEXT_LAYOUT === undefined ? 'frozen' : contextLayout)
  if (runtimeClockMode !== 'live' && runtimeClockMode !== 'frozen') throw new Error('MINI_DSH_RUNTIME_TIME_MODE must be live or frozen')
  const preview = env.MINI_DSH_TOOL_PREVIEW_BYTES
  let toolOutputMaxPreviewBytes: number | undefined
  if (preview !== undefined) {
    if (!/^[1-9]\d*$/.test(preview) || !Number.isSafeInteger(Number(preview))) throw new Error('MINI_DSH_TOOL_PREVIEW_BYTES must be a positive safe integer')
    toolOutputMaxPreviewBytes = Number(preview)
  }
  return {
    ...memoryConfig(env),
    workspace: env.MINI_DSH_WORKSPACE ?? cwd,
    profile,
    contextLayout,
    runtimeClockMode,
    ...(env.MINI_DSH_PROJECT_DIRECTORY === undefined ? {} : { projectDirectory: env.MINI_DSH_PROJECT_DIRECTORY }),
    ...(toolOutputMaxPreviewBytes === undefined ? {} : { toolOutputMaxPreviewBytes }),
  }
}

function memoryConfig(env: Environment): Pick<HarnessConfig, 'memory'> {
  const mode = env.MINI_DSH_MEMORY ?? 'off'
  if (!['off', 'recall', 'assist'].includes(mode)) throw new Error('MINI_DSH_MEMORY must be off, recall or assist')
  if (mode === 'off') return {}
  return { memory: { mode: mode as 'recall' | 'assist', ...(env.MINI_DSH_MEMORY_DIR ? { directory: env.MINI_DSH_MEMORY_DIR } : {}), ...(env.MINI_DSH_MEMORY_PROJECT_ID ? { projectId: env.MINI_DSH_MEMORY_PROJECT_ID } : {}) } }
}
