import type { Agent, Loop, ModelSelection } from './contracts.js'
import { randomUUID } from 'node:crypto'

export class AgentRuntime {
    #agents = new Map<string, Agent>()

    register(agent: Agent) {
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

    create({ sessionId, model, loop, name = 'default', budget }: { sessionId: string; model: ModelSelection; loop: Loop; name?: string; budget?: import('./budget.js').BudgetPolicy }) {
        const agent: Agent = {
            id: randomUUID(),
            name,
            sessionId,
            model,
            budget,

            async continue(options = {}) { return loop.run(agent, undefined, options) },
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