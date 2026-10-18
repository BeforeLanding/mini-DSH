import { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import type { Adapter } from '../core/contracts.js'
import type { CommandOptions, CommandResult } from '../core/command-runner.js'
import * as sessions from '../plugins/session.js'
import * as systemPrompt from '../plugins/system-prompt.js'
import * as tools from '../plugins/tools.js'
import * as llm from '../plugins/llm.js'
import * as agents from '../plugins/agent.js'
import * as agentLoop from '../plugins/agent-loop.js'
import * as runtimeContext from '../plugins/runtime-context.js'
import * as projectContext from '../plugins/project-context.js'
import * as sandbox from '../plugins/sandbox.js'
import * as toolResults from '../plugins/tool-results.js'
import * as readHistory from '../plugins/read-history.js'
import * as files from '../tools/files.js'
import * as bash from '../tools/bash.js'

export interface HarnessAdapter { provider: string; model: string; chat: Adapter['chat']; capabilities?: Adapter['capabilities'] }
export interface HarnessConfig {
  workspace: string
  profile: 'general' | 'coding'
  adapter?: HarnessAdapter
  commandRunner?: (options: CommandOptions) => Promise<CommandResult>
  autoApprove?: boolean
  projectDirectory?: string
  contextLayout?: 'live' | 'frozen'
  runtimeTime?: () => string
  projectContext?: boolean
  toolOutputMaxPreviewBytes?: number
  toolOutput?: boolean
  // Only the explicitly named pre-v2 path may omit this production capability.
  legacyNoReadHistory?: boolean
}

export async function createHarness(config: HarnessConfig) {
  const root = new Context()
  try {
    for (const plugin of [sessions, systemPrompt, tools, llm, agents, agentLoop]) await root.plugin(plugin)
    await root.plugin(runtimeContext, { workspace: config.workspace, profile: config.profile, ...(config.contextLayout ? { layout: config.contextLayout } : {}), ...(config.runtimeTime ? { now: config.runtimeTime } : {}) })
    await root.plugin(sandbox, { workspace: config.workspace, ...(config.autoApprove === undefined ? {} : { autoApprove: config.autoApprove }) })
    if (config.toolOutput !== false) await root.plugin(toolResults, { maxPreviewBytes: config.toolOutputMaxPreviewBytes })
    if (!config.legacyNoReadHistory) await root.plugin(readHistory)
    if (config.projectContext !== false && config.profile === 'coding') await root.plugin(projectContext, { directory: config.projectDirectory, ...(config.contextLayout ? { layout: config.contextLayout } : {}) })
    await root.plugin(files, { workspace: config.workspace })
    await root.plugin(bash, { workspace: config.workspace, ...(config.commandRunner ? { commandRunner: config.commandRunner } : {}) })
    if (config.adapter) root.llm.register(config.adapter.provider, { models: [config.adapter.model], ...(config.adapter.capabilities ? { capabilities: config.adapter.capabilities } : {}), chat: config.adapter.chat })
    const schemas = root.tools.schemas()
    const capabilityManifest = {
      tools: schemas.map(schema => schema.function.name).sort(),
      toolSchemaSha256: createHash('sha256').update(JSON.stringify(schemas.slice().sort((a, b) => a.function.name.localeCompare(b.function.name)))).digest('hex'),
      policy: { profile: config.profile, contextLayout: config.contextLayout ?? 'live', projectContext: config.projectContext !== false && config.profile === 'coding', toolOutput: config.toolOutput !== false, toolOutputMaxPreviewBytes: config.toolOutputMaxPreviewBytes ?? null, legacyNoReadHistory: config.legacyNoReadHistory === true, autoApprove: config.autoApprove ?? false, isolatedCommandRunner: config.commandRunner !== undefined },
    }
    return { root, capabilityManifest, dispose: () => root.fiber.dispose() }
  } catch (error) {
    await root.fiber.dispose()
    throw error
  }
}
