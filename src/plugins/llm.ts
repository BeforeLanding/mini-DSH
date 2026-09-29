import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { LlmRuntime } from '../core/llm-runtime.js'

class LlmService extends Service {
    runtime: LlmRuntime
    constructor(ctx: Context) {
        super(ctx, 'llm')
        this.runtime = new LlmRuntime()
    }

    register(...args: Parameters<LlmRuntime['register']>) {
        return this.runtime.register(...args)
    }

    capacity(...args: Parameters<LlmRuntime['capacity']>) { return this.runtime.capacity(...args) }
    models() {
        return this.runtime.models()
    }

    defaultSelection() {
        return this.runtime.defaultSelection()
    }

    has(...args: Parameters<LlmRuntime['has']>) {
        return this.runtime.has(...args)
    }

    chat(...args: Parameters<LlmRuntime['chat']>) {
        return this.runtime.chat(...args)
    }
}

export const name = 'mini-llm'

export function apply(ctx: Context) {
    ctx.plugin(LlmService)
}