import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { SandboxRuntime } from '../core/sandbox-runtime.js'
import path from 'node:path'

class SandboxService extends Service {
    runtime: SandboxRuntime
  constructor(ctx: Context, config: ConstructorParameters<typeof SandboxRuntime>[0]) {
    super(ctx, 'sandbox')
    this.runtime = new SandboxRuntime(config)
  }
  get workspace() { return this.runtime.workspace }
  resolvePath(...args: Parameters<SandboxRuntime['resolvePath']>) { return this.runtime.resolvePath(...args) }
  inspectCommand(...args: Parameters<SandboxRuntime['inspectCommand']>) { return this.runtime.inspectCommand(...args) }
  assertCommand(...args: Parameters<SandboxRuntime['assertCommand']>) { return this.runtime.assertCommand(...args) }
  setApprover(...args: Parameters<SandboxRuntime['setApprover']>) { return this.runtime.setApprover(...args) }
  approve(...args: Parameters<SandboxRuntime['approve']>) { return this.runtime.approve(...args) }
}
export const name = 'mini-sandbox'
export const inject = ['systemPrompt']
export async function apply(ctx: Context, config: ConstructorParameters<typeof SandboxRuntime>[0] = {}) {
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
