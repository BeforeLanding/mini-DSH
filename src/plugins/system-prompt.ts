import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { SystemPromptRuntime } from '../core/system-prompt-runtime.js'

class SystemPromptService extends Service {
    runtime: SystemPromptRuntime
    constructor(ctx: Context) {
        super(ctx, 'systemPrompt')
        this.runtime = new SystemPromptRuntime()
    }
    section(...args: Parameters<SystemPromptRuntime['section']>) {
        return this.runtime.section(...args)
    }
    context(...args: Parameters<SystemPromptRuntime['context']>) {
        return this.runtime.context(...args)
    }
    assemble(...args: Parameters<SystemPromptRuntime['assemble']>) {
        return this.runtime.assemble(...args)
    }
    inspect() {
        return this.runtime.inspect()
    }
}

export const name = 'mini-system-prompt'
export function apply(ctx: Context) {
    ctx.plugin(SystemPromptService)
}