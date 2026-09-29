import type { Arguments, EventData, Session, SessionEvent, Message } from './contracts.js'
import { randomUUID } from 'node:crypto'

export class SessionRuntime {
    #sessions = new Map<string, Session>()

    //six public methods: create, get, append, clear, list, deriveMessages

    create(meta: Arguments = {}) {
        const id = randomUUID()// Generate a unique session ID

        const session: Session = {
            id,
            meta: { ...meta },//shallow copy of meta
            events: [],
            createdAt: new Date().toISOString(),
        }

        this.#sessions.set(id, session)// Store the session in the private map
        this.append(id, 'session/start', { meta })
        return session
    }

    get(id: string) {
        const session = this.#sessions.get(id)
        if (!session) {
            throw new Error(`Session ${id} not found`)
        }
        return session
    }

    append<K extends keyof EventData>(id: string, type: K, data: EventData[K]) {
        const session = this.get(id)

        const event = {
            seq: session.events.length + 1,
            type,
            data,
            at: new Date().toISOString(),
        }
        session.events.push(event as SessionEvent)

        return event
    }

    // Clear the session events but keep the meta data
    clear(id: string) {
        const old = this.get(id)
        old.events = []
        this.append(id, 'session/start', { meta: old.meta, reset: true })
    }

    // List all sessions with their metadata and creation time
    list() {
        return [...this.#sessions.values()]
    }

    // Derive messages from the session events for a given session ID
    deriveMessages(id: string) {
        const events = this.get(id).events
        const messages: Message[] = []

        for (const event of events) {
            const { type, data } = event

            if (type === 'user/message') {
                messages.push({
                    role: 'user',
                    content: data.content,
                })
            }

            if (type === 'assistant/message') {
                messages.push({
                    role: 'assistant',
                    content: data.content,
                })
            }

            if (type === 'assistant/tool_calls') {
                messages.push({
                    role: 'assistant',
                    content: data.content ?? null,
                    ...(data.reasoningContent ? { reasoning_content: data.reasoningContent } : {}),
                    tool_calls: data.toolCalls.map((call) => ({
                        id: call.id,
                        type: 'function',
                        function: {
                            name: call.name,
                            arguments: JSON.stringify(call.arguments ?? {}),// Convert arguments to a JSON string
                        },
                    })),
                })
            }

            if (type === 'tool/result') {
                messages.push({
                    role: 'tool',
                    tool_call_id: data.toolCallId,
                    content: data.content,
                })
            }
        }

        return messages
    }
}