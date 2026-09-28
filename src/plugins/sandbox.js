import { Service } from '@deepseek-ai/cordis'
import { SandboxRuntime } from '../core/sandbox-runtime.js'
import path from 'node:path'

class SandboxService extends Service {
  constructor(ctx, config) {
    super(ctx, 'sandbox')
    this.runtime = new SandboxRuntime(config)
  }
  get workspace() { return this.runtime.workspace }
  resolvePath(requested) { return this.runtime.resolvePath(requested) }
  inspectCommand(command) { return this.runtime.inspectCommand(command) }
  assertCommand(command) { return this.runtime.assertCommand(command) }
  setApprover(fn) { return this.runtime.setApprover(fn) }
  approve(request) { return this.runtime.approve(request) }
}
export const name = 'mini-sandbox'
export const inject = ['systemPrompt']
export async function apply(ctx, config = {}) {
  const workspace = path.resolve(config.workspace ?? process.env.MINI_DSH_WORKSPACE ?? process.cwd())
  await ctx.plugin(SandboxService, {
    ...config,
    workspace,
    autoApprove: config.autoApprove ?? process.env.MINI_DSH_AUTO_APPROVE === '1',
  })
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'sandbox:policy', order: 15,
    text: `## Sandbox\nWork only inside ${workspace}. File writes and bash execution require user approval. Recursive deletion, system paths and unauthorized network requests are blocked. This is an application policy, not OS isolation.`,
  }), 'register sandbox policy')
}
