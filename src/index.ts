import dotenv from 'dotenv'
import { createHarness } from './app/create-harness.js'
import * as deepseek from './models/deepseek.js'
import * as cli from './plugins/cli.js'
import * as externalPlugins from './plugins/external-plugins.js'

dotenv.config({ quiet: true })
const { default: externalConfig } = await import('../plugins.config.js')

const workspace = process.env.MINI_DSH_WORKSPACE ?? process.cwd()
let harness: Awaited<ReturnType<typeof createHarness>> | undefined

try {
  const profile = process.env.MINI_DSH_PROFILE ?? 'coding'
  if (profile !== 'general' && profile !== 'coding') throw new Error('MINI_DSH_PROFILE must be general or coding')
  harness = await createHarness({ workspace, profile, projectDirectory: process.env.MINI_DSH_PROJECT_DIRECTORY })
  const { root } = harness
  await root.plugin(deepseek)
  await root.plugin(externalPlugins, { entries: externalConfig })
  await root.plugin(cli, { model: process.env.MINI_DSH_MODEL })
} catch (error) {
  console.error(`[startup] ${error instanceof Error ? error.message : String(error)}`)
  await harness?.dispose()
  process.exitCode = 1
}
