import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { ToolRuntime } from '../core/tool-runtime.js'

class ToolsService extends Service {
    runtime: ToolRuntime
    constructor(ctx: Context) {
        super(ctx, 'tools')
        this.runtime = new ToolRuntime()
    }
    register(...args: Parameters<ToolRuntime['register']>) {
        return this.runtime.register(...args)
    }
    get(...args: Parameters<ToolRuntime['get']>) {
        return this.runtime.get(...args)
    }
    list() {
        return this.runtime.list()
    }
    schemas() {
        return this.runtime.schemas()
    }
    execute(...args: Parameters<ToolRuntime['execute']>) {
        return this.runtime.execute(...args)
    }
    renderResult(...args: Parameters<ToolRuntime['renderResult']>) {
        return this.runtime.renderResult(...args)
    }
    setResultProjection(...args: Parameters<ToolRuntime['setResultProjection']>) {
        return this.runtime.setResultProjection(...args)
    }
    setAuthorization(...args: Parameters<ToolRuntime['setAuthorization']>) {
        return this.runtime.setAuthorization(...args)
    }
    setCapabilities(...args: Parameters<ToolRuntime['setCapabilities']>) { return this.runtime.setCapabilities(...args) }
    setAdmission(...args: Parameters<ToolRuntime['setAdmission']>) { return this.runtime.setAdmission(...args) }
}

export const name = 'mini-tools'
export function apply(ctx: Context) {
    ctx.plugin(ToolsService)
}
