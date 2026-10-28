#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import type { createHarness } from './app/create-harness.js'

let harness: Awaited<ReturnType<typeof createHarness>> | undefined

try {
  let args = process.argv.slice(2)
  let mcpConfigPath: string | undefined
  const mcpFlag = args.indexOf('--mcp-config')
  if (mcpFlag >= 0) {
    mcpConfigPath = args[mcpFlag + 1]
    if (!mcpConfigPath || mcpConfigPath.startsWith('--')) throw new Error('--mcp-config requires a path')
    args = args.filter((_, index) => index !== mcpFlag && index !== mcpFlag + 1)
  }
  if (args[0] === 'inspect') {
    const options = args.slice(1)
    if (!options.length || options.length > 4 || options.slice(1).some(option => !['--json', '--trace', '--tree'].includes(option)) || new Set(options.slice(1)).size !== options.length - 1)
      throw new Error('usage: mini-dsh inspect <session-jsonl-path> [--json] [--trace] [--tree]')
    const { inspectSession, formatInspect } = await import('./core/session-inspect.js')
    const report = await inspectSession(options[0]!, { trace: options.includes('--trace'), tree: options.includes('--tree') })
    console.log(options.includes('--json') ? JSON.stringify(report, null, 2) : formatInspect(report))
    if (!report.integrity.complete) process.exitCode = 2
  } else if (args[0] === 'demo') {
    if (args.length > 2 || (args.length === 2 && args[1] !== 'fix')) throw new Error('usage: mini-dsh demo [fix]')
    const { runDemo } = await import('./app/demo.js')
    const result = await runDemo()
    if (!result.passed) process.exitCode = 1
  } else if (args.length > 1 || (args.length === 1 && !['--help', '--version', '--show-config', 'demo'].includes(args[0]!))) {
    throw new Error('usage: mini-dsh [--help|--version|--show-config|demo [fix]] | inspect <session-jsonl-path> [--json] [--trace] [--tree]')
  } else if (args[0] === '--help') {
    console.log('Usage: mini-dsh [--help|--version|--show-config|demo [fix]] [--mcp-config <path>]\n       mini-dsh inspect <session-jsonl-path> [--json] [--trace] [--tree]\nRun in the target workspace directory. --show-config, inspect, and demo need no API key; interactive use requires DEEPSEEK_API_KEY in the environment or current directory .env.\nMCP defaults to no servers; user config: ~/.mini-dsh/mcp.json (override with MINI_DSH_MCP_CONFIG or --mcp-config). Workspace mcp.json is not auto-loaded. Set MINI_DSH_MCP=0 to disable.\nSession logs: ~/.mini-dsh/sessions (override with MINI_DSH_SESSION_DIR).')
  } else if (args[0] === '--version') {
    const metadata: unknown = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
    if (!metadata || typeof metadata !== 'object' || !('version' in metadata) || typeof metadata.version !== 'string') throw new Error('package version is unavailable')
    console.log(metadata.version)
  } else {
    const { default: dotenv } = await import('dotenv')
    const { productionHarnessConfig } = await import('./app/production-config.js')
    const initiallySet = new Set(['MINI_DSH_SESSION_ID', 'MINI_DSH_MODEL', 'MINI_DSH_WORKSPACE', 'MINI_DSH_PROFILE',
      'MINI_DSH_CONTEXT_LAYOUT', 'MINI_DSH_RUNTIME_TIME_MODE', 'MINI_DSH_PROJECT_DIRECTORY', 'MINI_DSH_TOOL_PREVIEW_BYTES', 'MINI_DSH_BUDGET',
      'MINI_DSH_AUTO_APPROVE', 'MINI_DSH_MEMORY', 'MINI_DSH_MEMORY_DIR', 'MINI_DSH_MEMORY_PROJECT_ID', 'MINI_DSH_MEMORY_LIMITS', 'MINI_DSH_DELEGATION', 'MINI_DSH_TEAM_DIR', 'MINI_DSH_TEAM_LIMITS', 'MINI_DSH_TASK_GROUP_BUDGET'].filter(key => process.env[key] !== undefined))
    const dotenvResult = dotenv.config({ quiet: true })
    if (args[0] === '--show-config') {
    const { inspectProductionConfig } = await import('./app/config-inspection.js')
    const origin = (key: string) => initiallySet.has(key) ? 'environment' as const
      : Object.hasOwn(dotenvResult.parsed ?? {}, key) ? '.env' as const : 'default' as const
    console.log(JSON.stringify(await inspectProductionConfig(process.env, origin, process.cwd(), { mcpConfigPath }), null, 2))
    } else {
      const { createHarness } = await import('./app/create-harness.js')
      const [deepseek, cli, { loadMcpServers }] = await Promise.all([
        import('./models/deepseek.js'), import('./plugins/cli.js'), import('./app/mcp-config.js'),
      ])
      const productionConfig = productionHarnessConfig()
      const mcp = await loadMcpServers({ ...(mcpConfigPath ? { configPath: mcpConfigPath } : {}) })
      harness = await createHarness({ ...productionConfig, ...(mcp.servers.length ? { mcpServers: mcp.servers } : {}) })
      const { root } = harness
      await root.plugin(deepseek)
      await root.plugin(cli, { model: process.env.MINI_DSH_MODEL, contextLayout: productionConfig.contextLayout ?? 'live', runtimeClockMode: productionConfig.runtimeClockMode, ...(harness.memory ? { memory: harness.memory } : {}), ...(harness.taskGroups ? { taskGroups: harness.taskGroups } : {}) })
    }
  }
} catch (error) {
  console.error(`[startup] ${error instanceof Error ? error.message : String(error)}`)
  await harness?.dispose()
  process.exitCode = 1
}
