import type { HarnessConfig } from './create-harness.js'
import { recordObject } from '../core/content-hash.js'
import { groupPolicy } from '../core/task-group-budget.js'
import { delegationLimits } from '../core/delegation-contracts.js'

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
    ...teamConfig(env),
    workspace: env.MINI_DSH_WORKSPACE ?? cwd,
    profile,
    contextLayout,
    runtimeClockMode,
    ...(env.MINI_DSH_PROJECT_DIRECTORY === undefined ? {} : { projectDirectory: env.MINI_DSH_PROJECT_DIRECTORY }),
    ...(toolOutputMaxPreviewBytes === undefined ? {} : { toolOutputMaxPreviewBytes }),
  }
}

function objectOption(text: string, name: string) {
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error(`${name} must be a JSON object`) }
  if (!recordObject(value)) throw new Error(`${name} must be a JSON object`)
  return value
}
function teamConfig(env: Environment): Pick<HarnessConfig, 'delegation' | 'taskGroupPolicy'> {
  const mode = env.MINI_DSH_DELEGATION ?? 'off'
  if (!['off', 'read-only'].includes(mode)) throw new Error('MINI_DSH_DELEGATION must be off or read-only')
  const policy = env.MINI_DSH_TASK_GROUP_BUDGET ? groupPolicy(objectOption(env.MINI_DSH_TASK_GROUP_BUDGET, 'MINI_DSH_TASK_GROUP_BUDGET')) : undefined
  if (mode === 'off') return policy ? { taskGroupPolicy: policy } : {}
  return { delegation: { mode: 'read-only', ...(env.MINI_DSH_TEAM_DIR ? { directory: env.MINI_DSH_TEAM_DIR } : {}), ...(env.MINI_DSH_TEAM_LIMITS ? { limits: delegationLimits(objectOption(env.MINI_DSH_TEAM_LIMITS, 'MINI_DSH_TEAM_LIMITS')) } : {}) }, ...(policy ? { taskGroupPolicy: policy } : {}) }
}
