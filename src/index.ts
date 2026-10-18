#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import type { createHarness } from './app/create-harness.js'

let harness: Awaited<ReturnType<typeof createHarness>> | undefined

try {
  const args = process.argv.slice(2)
  if (args[0] === 'inspect') {
    const options = args.slice(1)
    if (!options.length || options.length > 2 || options.slice(1).some(option => option !== '--json'))
      throw new Error('usage: mini-dsh inspect <session-jsonl-path> [--json]')
    const { inspectSession, formatInspect } = await import('./core/session-inspect.js')
    const report = await inspectSession(options[0]!)
    console.log(options.includes('--json') ? JSON.stringify(report, null, 2) : formatInspect(report))
    if (!report.integrity.complete) process.exitCode = 2
  } else if (args.length > 1 || (args.length === 1 && !['--help', '--version', '--show-config'].includes(args[0]!))) {
    throw new Error('usage: mini-dsh [--help|--version|--show-config] | inspect <session-jsonl-path> [--json]')
  } else if (args[0] === '--help') {
    console.log('Usage: mini-dsh [--help|--version|--show-config]\n       mini-dsh inspect <session-jsonl-path> [--json]\nRun in the target workspace directory. --show-config and inspect need no API key; interactive use requires DEEPSEEK_API_KEY in the environment or current directory .env.\nSession logs: ~/.mini-dsh/sessions (override with MINI_DSH_SESSION_DIR).')
  } else if (args[0] === '--version') {
    const metadata: unknown = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
    if (!metadata || typeof metadata !== 'object' || !('version' in metadata) || typeof metadata.version !== 'string') throw new Error('package version is unavailable')
    console.log(metadata.version)
  } else {
    const { default: dotenv } = await import('dotenv')
    const { productionHarnessConfig } = await import('./app/production-config.js')
    const initiallySet = new Set(['MINI_DSH_SESSION_ID', 'MINI_DSH_MODEL', 'MINI_DSH_WORKSPACE', 'MINI_DSH_PROFILE',
      'MINI_DSH_CONTEXT_LAYOUT', 'MINI_DSH_PROJECT_DIRECTORY', 'MINI_DSH_TOOL_PREVIEW_BYTES', 'MINI_DSH_BUDGET',
      'MINI_DSH_AUTO_APPROVE'].filter(key => process.env[key] !== undefined))
    const dotenvResult = dotenv.config({ quiet: true })
    if (args[0] === '--show-config') {
    const { inspectProductionConfig } = await import('./app/config-inspection.js')
    const origin = (key: string) => initiallySet.has(key) ? 'environment' as const
      : Object.hasOwn(dotenvResult.parsed ?? {}, key) ? '.env' as const : 'default' as const
    console.log(JSON.stringify(await inspectProductionConfig(process.env, origin), null, 2))
    } else {
      const { createHarness } = await import('./app/create-harness.js')
      const [deepseek, cli, externalPlugins] = await Promise.all([
        import('./models/deepseek.js'), import('./plugins/cli.js'), import('./plugins/external-plugins.js'),
      ])
      const productionConfig = productionHarnessConfig()
      harness = await createHarness(productionConfig)
      const { root } = harness
      const { default: externalConfig } = await import('../plugins.config.js')
      await root.plugin(deepseek)
      await root.plugin(externalPlugins, { entries: externalConfig })
      await root.plugin(cli, { model: process.env.MINI_DSH_MODEL, contextLayout: productionConfig.contextLayout ?? 'live' })
    }
  }
} catch (error) {
  console.error(`[startup] ${error instanceof Error ? error.message : String(error)}`)
  await harness?.dispose()
  process.exitCode = 1
}
