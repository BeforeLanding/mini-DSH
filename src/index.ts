import dotenv from 'dotenv'
import { createHarness } from './app/create-harness.js'
import { productionHarnessConfig } from './app/production-config.js'
import { inspectProductionConfig } from './app/config-inspection.js'
import * as deepseek from './models/deepseek.js'
import * as cli from './plugins/cli.js'
import * as externalPlugins from './plugins/external-plugins.js'

const initiallySet = new Set(['MINI_DSH_SESSION_ID', 'MINI_DSH_MODEL', 'MINI_DSH_WORKSPACE', 'MINI_DSH_PROFILE',
  'MINI_DSH_CONTEXT_LAYOUT', 'MINI_DSH_PROJECT_DIRECTORY', 'MINI_DSH_TOOL_PREVIEW_BYTES', 'MINI_DSH_BUDGET',
  'MINI_DSH_AUTO_APPROVE'].filter(key => process.env[key] !== undefined))
const dotenvResult = dotenv.config({ quiet: true })

let harness: Awaited<ReturnType<typeof createHarness>> | undefined

try {
  if (process.argv.includes('--show-config')) {
    if (process.argv.length !== 3 || process.argv[2] !== '--show-config') throw new Error('usage: --show-config')
    const origin = (key: string) => initiallySet.has(key) ? 'environment' as const
      : Object.hasOwn(dotenvResult.parsed ?? {}, key) ? '.env' as const : 'default' as const
    console.log(JSON.stringify(await inspectProductionConfig(process.env, origin), null, 2))
  } else {
    const productionConfig = productionHarnessConfig()
    harness = await createHarness(productionConfig)
    const { root } = harness
    const { default: externalConfig } = await import('../plugins.config.js')
    await root.plugin(deepseek)
    await root.plugin(externalPlugins, { entries: externalConfig })
    await root.plugin(cli, { model: process.env.MINI_DSH_MODEL, contextLayout: productionConfig.contextLayout ?? 'live' })
  }
} catch (error) {
  console.error(`[startup] ${error instanceof Error ? error.message : String(error)}`)
  await harness?.dispose()
  process.exitCode = 1
}
