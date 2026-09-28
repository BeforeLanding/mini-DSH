import { Service } from '@deepseek-ai/cordis'
import { SessionRuntime } from '../core/session-runtime.js'

//connect SessionRuntime to the Cordis service framework, allowing session management through the SessionsService class.
class SessionsService extends Service {
    constructor(ctx) {
        super(ctx, 'sessions')// Initialize the service with the context and name 'sessions'
        this.runtime = new SessionRuntime()
    }

    create(meta) {
        return this.runtime.create(meta)
    }
    get(id) {
        return this.runtime.get(id)
    }
    append(id, type, data) {
        return this.runtime.append(id, type, data)
    }
    clear(id) {
        return this.runtime.clear(id)
    }
    list() {
        return this.runtime.list()
    }
    deriveMessages(id) {
        return this.runtime.deriveMessages(id)
    }
}

export const name = 'mini-sessions'
// Export the name of the plugin as 'mini-sessions'
export function apply(ctx) {
    ctx.plugin(SessionsService)
}
// Apply the SessionsService plugin to the provided context, enabling session management capabilities