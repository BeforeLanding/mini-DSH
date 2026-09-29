import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { AgentLoopRuntime } from '../core/agent-loop-runtime.js'

class AgentLoopService extends Service {
    runtime: AgentLoopRuntime
    static inject = ['sessions', 'systemPrompt', 'tools', 'llm']

    constructor(ctx: Context) {
        super(ctx, 'agentLoop')
        this.runtime = new AgentLoopRuntime({
            sessions: ctx.sessions,
            systemPrompt: ctx.systemPrompt,
            tools: ctx.tools,
            llm: ctx.llm,
        })
    }

    run(...args: Parameters<AgentLoopRuntime['run']>) {
        return this.runtime.run(...args)
    }
}

export const name = 'mini-agent-loop'
export const inject = ['sessions', 'systemPrompt', 'tools', 'llm']

export function apply(ctx: Context) {
    ctx.plugin(AgentLoopService)
}