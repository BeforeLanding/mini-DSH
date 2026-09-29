import type { Context } from '@deepseek-ai/cordis'
import path from 'node:path'
import os from 'node:os'

export const name = 'mini-runtime-context'
export const inject = ['systemPrompt']

// The apply function registers the runtime context plugin with the mini-DSH context, providing system prompt sections that describe the agent's identity and the runtime environment. It allows for customization of the workspace path through configuration or environment variables.
export function apply(ctx: Context, config: { workspace?: string } = {}) {
  const workspace = path.resolve(config.workspace ?? process.env.MINI_DSH_WORKSPACE ?? process.cwd())
  
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'agent:identity', order: 10,
    text: 'You are a general-purpose agent running in a local Harness. Prefer tools to verify facts when possible. Use the tools provided in this request when asked about available tools. Reply in English by default.',
  }), 'register agent identity')

  ctx.effect(() => ctx.systemPrompt.context({
    name: 'runtime:environment', order: 100,
    text: () => ['## Runtime Context', `Time: ${new Date().toISOString()}`,
      `Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`, `Workspace: ${workspace}`,
      `Platform: ${process.platform}`, `Node: ${process.version}`, `Hostname: ${os.hostname()}`].join('\n'),
  }), 'register runtime context')
}
