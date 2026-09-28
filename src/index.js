import { Context } from '@deepseek-ai/cordis'
import dotenv from 'dotenv'
import * as sessions from './plugins/session.js'
import * as systemPrompt from './plugins/system-prompt.js'
import * as tools from './plugins/tools.js'
import * as llm from './plugins/llm.js'
import * as agents from './plugins/agent.js'
import * as agentLoop from './plugins/agent-loop.js'
import * as runtimeContext from './plugins/runtime-context.js'
import * as deepseek from './models/deepseek.js'
import * as cli from './plugins/cli.js'

dotenv.config({ quiet: true })
const root = new Context()
const workspace = process.env.MINI_DSH_WORKSPACE ?? process.cwd()
try {
  for (const plugin of [sessions, systemPrompt, tools, llm, agents, agentLoop]) await root.plugin(plugin)
  await root.plugin(runtimeContext, { workspace })
  await root.plugin(deepseek)
  await root.plugin(cli, { model: process.env.MINI_DSH_MODEL ?? 'deepseek/deepseek-v4-pro' })
} catch (error) {
  console.error(`[startup] ${error.message}`)
  await root.fiber.dispose()
  process.exitCode = 1
}
