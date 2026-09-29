import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { SessionRuntime } from '../core/session-runtime.js'

class SessionsService extends Service {
    runtime: SessionRuntime
    constructor(ctx: Context) {
        super(ctx, 'sessions')
        this.runtime = new SessionRuntime()
    }

    restore(...args: Parameters<SessionRuntime['restore']>) { return this.runtime.restore(...args) }
    attachStore(...args: Parameters<SessionRuntime['attachStore']>) { return this.runtime.attachStore(...args) }
    flush(...args: Parameters<SessionRuntime['flush']>) { return this.runtime.flush(...args) }
    close() { return this.runtime.close() }
    visibleEvents(...args: Parameters<SessionRuntime['visibleEvents']>) { return this.runtime.visibleEvents(...args) }
    configuration(...args: Parameters<SessionRuntime['configuration']>) { return this.runtime.configuration(...args) }
    latestRun(...args: Parameters<SessionRuntime['latestRun']>) { return this.runtime.latestRun(...args) }
    beginRun(...args: Parameters<SessionRuntime['beginRun']>) { return this.runtime.beginRun(...args) }
    finishRun(...args: Parameters<SessionRuntime['finishRun']>) { return this.runtime.finishRun(...args) }
    taskState(...args: Parameters<SessionRuntime['taskState']>) { return this.runtime.taskState(...args) }
    taskCounters(...args: Parameters<SessionRuntime['taskCounters']>) { return this.runtime.taskCounters(...args) }
    create(...args: Parameters<SessionRuntime['create']>) {
        return this.runtime.create(...args)
    }
    get(...args: Parameters<SessionRuntime['get']>) {
        return this.runtime.get(...args)
    }
    append<K extends keyof import('../core/contracts.js').EventData>(id: string, type: K, data: import('../core/contracts.js').EventData[K], scope?: { taskId?: string; runId?: string }) {
        return this.runtime.append(id, type, data, scope)
    }
    clear(...args: Parameters<SessionRuntime['clear']>) {
        return this.runtime.clear(...args)
    }
    list() {
        return this.runtime.list()
    }
    deriveMessages(...args: Parameters<SessionRuntime['deriveMessages']>) {
        return this.runtime.deriveMessages(...args)
    }
}

export const name = 'mini-sessions'
export function apply(ctx: Context) {
    ctx.plugin(SessionsService)
}
