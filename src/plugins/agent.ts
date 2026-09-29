import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { AgentRuntime } from '../core/agent-runtime.js'

class AgentsService extends Service {
    runtime: AgentRuntime
    constructor(ctx: Context) {
        super(ctx, 'agents')
        this.runtime = new AgentRuntime()
    }
    register(...args: Parameters<AgentRuntime['register']>) {
        return this.runtime.register(...args)
    }
    create(...args: Parameters<AgentRuntime['create']>) {
        return this.runtime.create(...args)
    }
    list() {
        return this.runtime.list()
    }
}

export const name = 'mini-agents'
export function apply(ctx: Context) {
    ctx.plugin(AgentsService)
}