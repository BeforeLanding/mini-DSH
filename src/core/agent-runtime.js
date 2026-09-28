import { randomUUID } from 'node:crypto'

export class AgentRuntime {
    #agents = new Map()

    // Register a new agent with a unique ID and associated properties. Ensures that each agent is unique and provides a disposal function to remove the agent when no longer needed.
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

    // Create a new agent instance with a unique ID, session ID, model selection, and an optional name. The agent is registered in the runtime and can send messages through the provided loop.
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

    // Retrieve an agent by its unique ID. Throws an error if the agent is not found in the runtime.
    list() {
        return [...this.#agents.values()]
    }
}