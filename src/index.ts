import dotenv from 'dotenv'
import { createHarness } from './app/create-harness.js'
import { productionHarnessConfig } from './app/production-config.js'
import * as deepseek from './models/deepseek.js'
import * as cli from './plugins/cli.js'
import * as externalPlugins from './plugins/external-plugins.js'

dotenv.config({ quiet: true })
const { default: externalConfig } = await import('../plugins.config.js')

let harness: Awaited<ReturnType<typeof createHarness>> | undefined

try {
  harness = await createHarness(productionHarnessConfig())
  const { root } = harness
  await root.plugin(deepseek)
  await root.plugin(externalPlugins, { entries: externalConfig })
  await root.plugin(cli, { model: process.env.MINI_DSH_MODEL })
} catch (error) {
  console.error(`[startup] ${error instanceof Error ? error.message : String(error)}`)
  await harness?.dispose()
  process.exitCode = 1
}
