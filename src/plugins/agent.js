import { Service } from '@deepseek-ai/cordis'
import { AgentRuntime } from '../core/agent-runtime.js'

class AgentsService extends Service {
    constructor(ctx) {
        super(ctx, 'agents')
        this.runtime = new AgentRuntime()
    }
    register(agent) {
        return this.runtime.register(agent)
    }
    create(options) {
        return this.runtime.create(options)
    }
    list() {
        return this.runtime.list()
    }
}

export const name = 'mini-agents'
export function apply(ctx) {
    ctx.plugin(AgentsService)
}