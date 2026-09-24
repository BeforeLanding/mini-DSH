import { randomUUID } from 'node:crypto'

export class AgentRuntime {
    #agents = new Map()

    register(agent) {
        if (this.#agents.has(agent.id)) {
            throw new Error(`duplicate agent: ${agent.id}`)
        }

        this.#agents.set(agent.id, agent)

        let disposed = false
        return () => {
            if (disposed) return
            disposed = true
            if (this.#agents.get(agent.id) === agent) {
                this.#agents.delete(agent.id)
            }
        }
    }

    create({ sessionId, model, loop, name = 'default' }) {
        const agent = {
            id: randomUUID(),
            name,
            sessionId,
            model,

            async send(input, options = {}) {
                return loop.run(agent, input, options)
            },
        }

        this.register(agent)
        return agent
    }

    list() {
        return [...this.#agents.values()]
    }
}