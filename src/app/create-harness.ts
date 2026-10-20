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
import * as externalPlugins from '../plugins/external-plugins.js'
import * as files from '../tools/files.js'
import * as bash from '../tools/bash.js'
import { assertMcpRuntime } from './mcp-config.js'
import type { McpServerEntry } from './mcp-config.js'

export interface HarnessAdapter { provider: string; model: string; chat: Adapter['chat']; capabilities?: Adapter['capabilities'] }
export interface HarnessConfig {
  workspace: string
  profile: 'general' | 'coding'
  adapter?: HarnessAdapter
  commandRunner?: (options: CommandOptions) => Promise<CommandResult>
  autoApprove?: boolean
  projectDirectory?: string
  contextLayout?: 'live' | 'frozen'
  runtimeClockMode?: 'live' | 'frozen'
  runtimeTime?: () => string
  projectContext?: boolean
  toolOutputMaxPreviewBytes?: number
  toolOutput?: boolean
  // Only the explicitly named pre-v2 path may omit this production capability.
  legacyNoReadHistory?: boolean
  // 默认不装任何 MCP server。条目只来自用户目录级配置或显式路径；createHarness 不会自行扫描工作区。
  mcpServers?: McpServerEntry[]
}

export async function createHarness(config: HarnessConfig) {
  const root = new Context()
  try {
    for (const plugin of [sessions, systemPrompt, tools, llm, agents, agentLoop]) await root.plugin(plugin)
    const runtimeClockMode = config.runtimeClockMode ?? config.contextLayout ?? 'live'
    await root.plugin(runtimeContext, { workspace: config.workspace, profile: config.profile, layout: runtimeClockMode, ...(config.runtimeTime ? { now: config.runtimeTime } : {}) })
    await root.plugin(sandbox, { workspace: config.workspace, ...(config.autoApprove === undefined ? {} : { autoApprove: config.autoApprove }) })
    if (config.toolOutput !== false) await root.plugin(toolResults, { maxPreviewBytes: config.toolOutputMaxPreviewBytes })
    if (!config.legacyNoReadHistory) await root.plugin(readHistory)
    if (config.projectContext !== false && config.profile === 'coding') await root.plugin(projectContext, { directory: config.projectDirectory, ...(config.contextLayout ? { layout: config.contextLayout } : {}) })
    await root.plugin(files, { workspace: config.workspace })
    await root.plugin(bash, { workspace: config.workspace, ...(config.commandRunner ? { commandRunner: config.commandRunner } : {}) })
    // MCP 工具经 ToolRuntime 中央授权：插件不声明 effect/origin，因此按 unknown 默认询问；
    // failOnStartupError 固定为 false，连接失败只丢该 server 的工具，不阻断主循环。
    if (config.mcpServers?.length) { assertMcpRuntime(); await root.plugin(externalPlugins, { entries: config.mcpServers }) }
    if (config.adapter) root.llm.register(config.adapter.provider, { models: [config.adapter.model], ...(config.adapter.capabilities ? { capabilities: config.adapter.capabilities } : {}), chat: config.adapter.chat })
    const schemas = root.tools.schemas()
    const capabilityManifest = {
      tools: schemas.map(schema => schema.function.name).sort(),
      toolSchemaSha256: createHash('sha256').update(JSON.stringify(schemas.slice().sort((a, b) => a.function.name.localeCompare(b.function.name)))).digest('hex'),
      policy: { profile: config.profile, contextLayout: config.contextLayout ?? 'live', runtimeClockMode, projectContext: config.projectContext !== false && config.profile === 'coding', toolOutput: config.toolOutput !== false, toolOutputMaxPreviewBytes: config.toolOutputMaxPreviewBytes ?? null, legacyNoReadHistory: config.legacyNoReadHistory === true, autoApprove: config.autoApprove ?? false, isolatedCommandRunner: config.commandRunner !== undefined, mcpServers: config.mcpServers?.map(entry => entry.config.serverName) ?? [] },
    }
    return { root, capabilityManifest, dispose: () => root.fiber.dispose() }
  } catch (error) {
    await root.fiber.dispose()
    throw error
  }
}
