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
import { assertMcpRuntime, secureStdioEntry } from './mcp-config.js'
import type { McpServerEntry } from './mcp-config.js'
import os from 'node:os'
import path from 'node:path'
import { MemoryStore } from '../core/memory-store.js'
import { MemoryRuntime } from '../core/memory-runtime.js'
import type { MemoryRecallLimits } from '../core/memory-retriever.js'
import * as memoryPlugin from '../plugins/memory.js'
import { READ_ONLY_TOOLS, validateAgentRole } from '../core/agent-capabilities.js'
import type { AgentRole } from '../core/agent-capabilities.js'
import { TaskGroups, guardTaskGroup } from '../core/task-groups.js'
import { groupPolicy } from '../core/task-group-budget.js'
import type { TaskGroupPolicy, TaskGroupBudgetCoordinator } from '../core/task-group-budget.js'
import { DelegationRuntime } from '../core/delegation-runtime.js'
import type { DelegationLimits } from '../core/delegation-contracts.js'
import type { ToolResultStore } from '../core/tool-result-store.js'
import type { MemoryViewSnapshot } from '../core/memory-runtime.js'
import { JsonlStore } from '../core/event-store.js'
import { CLI_BUDGET } from '../core/budget.js'
import * as delegationPlugin from '../plugins/delegation.js'
import { delegationRecovery } from '../core/delegation-recovery.js'

export interface HarnessAdapter { provider: string; model: string; chat: Adapter['chat']; capabilities?: Adapter['capabilities'] }
export interface HarnessConfig {
  agentRole?: AgentRole
  taskGroupPolicy?: Partial<TaskGroupPolicy>
  // Host-only binding: child budgets always resolve to the parent's coordinator.
  parentTaskGroup?: TaskGroupBudgetCoordinator
  delegation?: { mode: 'off' | 'read-only'; directory?: string; limits?: Partial<DelegationLimits> }
  memoryRuntime?: MemoryRuntime
  memorySnapshot?: MemoryViewSnapshot
  memory?: { mode: 'off' | 'recall' | 'assist'; directory?: string; projectId?: string; readOnly?: boolean; limits?: Partial<MemoryRecallLimits> }
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
  const role = validateAgentRole(config.agentRole ?? 'coordinator'), readOnly = role !== 'coordinator'
  if (readOnly && (config.mcpServers?.length || config.commandRunner || config.memory?.mode === 'assist' || config.delegation?.mode === 'read-only')) throw new Error('read-only roles cannot configure MCP, commands, delegation or memory proposals')
  if (config.delegation && !['off', 'read-only'].includes(config.delegation.mode)) throw new Error('invalid delegation mode')
  if (config.delegation?.mode === 'read-only' && config.toolOutput === false) throw new Error('delegation requires parent-owned result storage')
  const root = new Context()
  let memory: memoryPlugin.MemoryController | undefined
  let memoryStore: MemoryStore | undefined
  let taskGroups: TaskGroups | undefined
  let delegation: DelegationRuntime | undefined
  let parentResults: ToolResultStore | undefined
  try {
    for (const plugin of [sessions, systemPrompt, tools, llm, agents, agentLoop]) await root.plugin(plugin)
    if (config.taskGroupPolicy || config.parentTaskGroup || config.delegation?.mode === 'read-only') {
      if (config.taskGroupPolicy && config.parentTaskGroup) throw new Error('child cannot override parent task group policy')
      taskGroups = config.parentTaskGroup ? undefined : new TaskGroups(root.sessions, groupPolicy(config.taskGroupPolicy))
      guardTaskGroup(root.llm, root.tools, root.sessions, config.parentTaskGroup ? async () => config.parentTaskGroup! : (sessionId, taskId) => taskGroups!.get(sessionId, taskId), { root: !config.parentTaskGroup })
    }
    if (readOnly) root.tools.setCapabilities(READ_ONLY_TOOLS)
    const runtimeClockMode = config.runtimeClockMode ?? config.contextLayout ?? 'live'
    await root.plugin(runtimeContext, { workspace: config.workspace, profile: config.profile, layout: runtimeClockMode, ...(readOnly ? { agentRole: role } : {}), ...(config.runtimeTime ? { now: config.runtimeTime } : {}) })
    await root.plugin(sandbox, { workspace: config.workspace, ...(config.autoApprove === undefined ? {} : { autoApprove: config.autoApprove }) })
    if (config.toolOutput !== false && !readOnly) await root.plugin(toolResults, { maxPreviewBytes: config.toolOutputMaxPreviewBytes, onStore: store => { parentResults = store } })
    if (!config.legacyNoReadHistory) await root.plugin(readHistory)
    if (config.projectContext !== false && config.profile === 'coding') await root.plugin(projectContext, { directory: config.projectDirectory, ...(config.contextLayout ? { layout: config.contextLayout } : {}) })
    await root.plugin(files, { workspace: config.workspace, ...(readOnly ? { allowedTools: READ_ONLY_TOOLS } : {}) })
    if (!readOnly) await root.plugin(bash, { workspace: config.workspace, ...(config.commandRunner ? { commandRunner: config.commandRunner } : {}) })
    if (config.memoryRuntime || (config.memory && config.memory.mode !== 'off')) {
      const mode = config.memory?.mode ?? 'recall'
      if (mode !== 'recall' && mode !== 'assist') throw new Error('invalid memory mode')
      if (!config.memoryRuntime) memoryStore = await MemoryStore.open({ directory: config.memory?.directory ?? path.join(os.homedir(), '.mini-dsh', 'memory'), workspace: config.workspace, projectId: config.memory?.projectId, readOnly: config.memory?.readOnly ?? readOnly })
      memory = new memoryPlugin.MemoryController(config.memoryRuntime ?? new MemoryRuntime(memoryStore!, config.memory?.limits), config.memorySnapshot)
      await root.plugin(memoryPlugin, { controller: memory, mode, ownsStore: !!memoryStore })
    }
    if (config.delegation?.mode === 'read-only') {
      const directory = path.resolve(config.delegation.directory ?? path.join(os.homedir(), '.mini-dsh', 'teams'))
      delegation = new DelegationRuntime({ workspace: config.workspace, directory, sessions: root.sessions, memory, results: parentResults!, group: (sessionId, taskId) => taskGroups!.get(sessionId, taskId),
        async buildChild(task, delegationId, execution, group, snapshot) {
          const adapter = root.llm.adapterFor(execution.agent!.model)
          const child = await createHarness({ workspace: config.workspace, profile: config.profile, agentRole: task.role, adapter, parentTaskGroup: group, contextLayout: config.contextLayout, runtimeClockMode,
            ...(memory && snapshot ? { memoryRuntime: memory.runtime, memorySnapshot: snapshot } : {}) })
          try {
            const session = child.root.sessions.create({ workspace: config.workspace, parentSessionId: execution.sessionId, parentToolCallId: execution.toolCallId, groupId: group.start.groupId, delegationId })
            const store = await JsonlStore.open(path.join(directory, 'sessions'), session.id)
            child.root.sessions.attachStore(session.id, store); await child.root.sessions.flush(session.id)
            const limits = delegation!.limits
            const capacity = adapter.capabilities?.[adapter.model]?.contextWindowTokens ?? root.sessions.latestRun(execution.sessionId!)?.policy.contextWindowTokens
            if (capacity === undefined) throw new Error('child model context capacity must be explicitly configured')
            const agent = child.root.agents.create({ sessionId: session.id, model: `${adapter.provider}/${adapter.model}`, loop: child.root.agentLoop,
              budget: { ...CLI_BUDGET, maxModelRequests: limits.childMaxModelRequests, maxToolCalls: limits.childMaxToolCalls, maxTotalTokens: limits.childMaxTotalTokens, contextWindowTokens: capacity } })
            return { sessionId: session.id, capabilityDigest: child.capabilityManifest.toolSchemaSha256, send: (input, signal) => agent.send(input, { signal }), status: () => child.root.sessions.latestRun(session.id)?.status,
              dispose: async () => { try { await child.root.sessions.close() } finally { await child.dispose() } } }
          } catch (error) { await child.root.sessions.close(); await child.dispose(); throw error }
        },
      }, config.delegation.limits)
      await root.plugin(delegationPlugin, { runtime: delegation })
      root.sessions.setDelegationRecovery(delegationRecovery(delegation.deps))
    }
    // MCP 工具经 ToolRuntime 中央授权：插件不声明 effect/origin，因此按 unknown 默认询问；
    // failOnStartupError 固定为 false，连接失败只丢该 server 的工具，不阻断主循环。
    if (config.mcpServers?.length) { assertMcpRuntime(); await root.plugin(externalPlugins, { entries: config.mcpServers.map(secureStdioEntry) }) }
    if (config.adapter) root.llm.register(config.adapter.provider, { models: [config.adapter.model], ...(config.adapter.capabilities ? { capabilities: config.adapter.capabilities } : {}), chat: config.adapter.chat })
    const schemas = root.tools.schemas()
    const capabilityManifest = {
      tools: schemas.map(schema => schema.function.name).sort(),
      toolSchemaSha256: createHash('sha256').update(JSON.stringify(schemas.slice().sort((a, b) => a.function.name.localeCompare(b.function.name)))).digest('hex'),
      policy: { profile: config.profile, contextLayout: config.contextLayout ?? 'live', runtimeClockMode, projectContext: config.projectContext !== false && config.profile === 'coding', toolOutput: config.toolOutput !== false && !readOnly, toolOutputMaxPreviewBytes: config.toolOutputMaxPreviewBytes ?? null, legacyNoReadHistory: config.legacyNoReadHistory === true, autoApprove: config.autoApprove ?? false, isolatedCommandRunner: config.commandRunner !== undefined, mcpServers: config.mcpServers?.map(entry => entry.config.serverName) ?? [] },
      ...(memory ? { memory: { mode: config.memory?.mode ?? 'recall', projectId: memory.runtime.store.projectId, limits: memory.runtime.limits } } : {}),
      ...(readOnly ? { role, capabilities: READ_ONLY_TOOLS } : {}),
      ...(config.taskGroupPolicy ? { taskGroupPolicy: groupPolicy(config.taskGroupPolicy) } : {}),
      ...(delegation ? { delegation: { mode: 'read-only', limits: delegation.limits, taskGroupPolicy: groupPolicy(config.taskGroupPolicy) } } : {}),
    }
    return { root, capabilityManifest, memory, taskGroups, delegation, dispose: async () => { try { await root.fiber.dispose() } finally { memory?.dispose(); await memoryStore?.close() } } }
  } catch (error) {
    await root.fiber.dispose()
    memory?.dispose(); await memoryStore?.close()
    throw error
  }
}
