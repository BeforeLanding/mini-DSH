import { Service } from '@deepseek-ai/cordis'
import { ToolRuntime } from '../core/tool-runtime.js'

class ToolsService extends Service {
    constructor(ctx) {
        super(ctx, 'tools')
        this.runtime = new ToolRuntime()
    }
    register(definition) {
        return this.runtime.register(definition)
    }
    get(name) {
        return this.runtime.get(name)
    }
    list() {
        return this.runtime.list()
    }
    schemas() {
        return this.runtime.schemas()
    }
    execute(name, args, exec) {
        return this.runtime.execute(name, args, exec)
    }
    renderResult(result) {
        return this.runtime.renderResult(result)
    }
}

export const name = 'mini-tools'
export function apply(ctx) {
    ctx.plugin(ToolsService)
}