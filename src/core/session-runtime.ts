import { pendingTools } from './pending-tools.js'
import { estimateUsage } from './token-estimator.js'
import path from 'node:path'
import { parseLog } from './event-store.js'
import type { EventStore } from './event-store.js'
import { emptyCounters } from './budget.js'
import type { BudgetPolicy, RunState, StopReason, Counters } from './budget.js'
import type { Arguments, EventData, Session, SessionEvent, Message } from './contracts.js'
import { randomUUID } from 'node:crypto'

export class SessionRuntime {
    #stores = new Map<string, EventStore>()
    #pending = new Map<string, Promise<void>>()
    attachStore(id: string, store: EventStore, existing = false) {
        if (this.#stores.has(id)) throw new Error('session already has a store')
        const session = this.get(id)
        this.#stores.set(id, store)
        let pending = Promise.resolve()
        if (!existing) for (const event of session.events) pending = pending.then(() => store.append(event))
        this.#pending.set(id, pending)
        void pending.catch(() => {})
    }
    async restore(store: EventStore, workspace?: string) {
        const raw = await store.read()
        if (!raw.length || raw[0].type !== 'session/start') throw new Error('missing session start')
        const id = raw[0].sessionId
        const events = parseLog(raw.map(e => JSON.stringify(e) + '\n').join(''), id)
        if (this.#sessions.has(id)) throw new Error('session already loaded')
        const meta = raw[0].data.meta
        if (workspace !== undefined && (typeof meta.workspace !== 'string' || path.resolve(meta.workspace) !== path.resolve(workspace))) throw new Error('session workspace mismatch; restore cannot execute in another workspace')
        const session: Session = { id, meta, events, createdAt: events[0].at }
        this.#sessions.set(id, session)
        this.attachStore(id, store, true)
        const visible = this.visibleEvents(id)
        for (const { call, scope, started } of pendingTools(visible)) {
            this.append(id, 'tool/result', { toolCallId: call.id, name: call.name, isError: true,
                status: started ? 'unknown' : 'skipped', content: started ? 'ToolError: unknown outcome after recovery; verify side effects before continuing' : 'ToolError: skipped before execution after recovery' }, scope)
        }
        for (const event of visible) {
            if (event.type !== 'model/start' || visible.some(e => e.type === 'model/usage' && e.data.requestId === event.data.requestId)) continue
            const chunks = visible.filter(e => e.type === 'model/fragment' && e.data.requestId === event.data.requestId)
            const content = chunks.map(e => e.type === 'model/fragment' ? e.data.content : '').join('')
            const reasoningContent = chunks.map(e => e.type === 'model/fragment' ? e.data.reasoningContent : '').join('')
            this.append(id, 'model/usage', { taskId: event.data.taskId, runId: event.data.runId, requestId: event.data.requestId,
                usage: estimateUsage(event.data.estimatedInputTokens ?? 256, { content, reasoningContent }) }, event)
            this.append(id, 'model/end', { requestId: event.data.requestId, complete: false }, event)
        }
        const state = this.latestRun(id)
        if (state?.status === 'running') this.finishRun(state, 'error')
        await this.flush(id)
        return session
    }
    async flush(id: string) { await this.#pending.get(id) }
    async close() {
        await Promise.allSettled([...this.#pending.values()])
        const results = await Promise.allSettled([...this.#stores.values()].map(store => store.close()))
        const failed = results.find(r => r.status === 'rejected')
        if (failed?.status === 'rejected') throw failed.reason
    }
    #sessions = new Map<string, Session>()


    visibleEvents(id: string) {
        const events = this.get(id).events
        const reset = events.map(e => e.type).lastIndexOf('session/reset')
        return events.slice(reset + 1)
    }
    configuration(id: string) {
        const event = [...this.visibleEvents(id)].reverse().find(e => e.type === 'session/config')
        return event?.type === 'session/config' ? structuredClone(event.data) : undefined
    }
    latestRun(id: string): RunState | undefined {
        const events = this.visibleEvents(id)
        const begin = [...events].reverse().find(e => e.type === 'run/start')
        if (!begin || begin.type !== 'run/start') return undefined
        const end = [...events].reverse().find(e => e.type === 'run/finish' && e.data.state.runId === begin.data.state.runId)
        if (end?.type === 'run/finish') return structuredClone(end.data.state)
        const state = structuredClone(begin.data.state)
        for (const event of events) {
            if (event.runId !== state.runId) continue
            if (event.type === 'model/start') state.counters.modelRequests++
            if (event.type === 'tool/start') state.counters.toolCalls++
            if (event.type === 'model/usage') {
                state.usage.push(event.data.usage)
                state.counters.inputTokens += event.data.usage.inputTokens
                state.counters.outputTokens += event.data.usage.outputTokens
                state.counters.totalTokens += event.data.usage.totalTokens
            }
        }
        return state
    }
    beginRun(id: string, policy: Readonly<BudgetPolicy>, model: string, continuing = false): RunState {
        if (this.latestRun(id)?.status === 'running') throw new Error('session is already running')
        const previous = this.latestRun(id)
        if (continuing) {
            if (!previous) throw new Error('no task to continue')
            if (previous.status === 'completed') throw new Error('task already completed')
            const unknown = this.visibleEvents(id).some(e => e.taskId === previous.taskId && e.type === 'tool/result' && e.data.status === 'unknown')
            if (unknown) throw new Error('unknown tool outcome; verify side effects before starting a new task; automatic continuation is blocked')
            const contextKeys = ['contextWindowTokens', 'inputTargetTokens', 'maxOutputTokens', 'safetyMarginTokens'] as const
            if (previous.status === 'context_overflow' && contextKeys.every(key => policy[key] === previous.policy[key]) && model === previous.model) throw new Error('context_overflow cannot continue with unchanged context configuration')
        }
        const state: RunState = { sessionId: id, taskId: continuing ? previous!.taskId : randomUUID(), runId: randomUUID(), model,
            ...(continuing ? { previousRunId: previous!.runId } : {}),
            policy, counters: emptyCounters(), status: 'running', usage: [], removedTaskIds: [] }
        this.append(id, 'run/start', { state }, state)
        return state
    }
    finishRun(state: RunState, status: StopReason) {
        if (this.visibleEvents(state.sessionId).some(e => e.type === 'run/finish' && e.data.state.runId === state.runId)) return
        state.status = status
        this.append(state.sessionId, 'run/finish', { state }, state)
    }
    taskState(id: string, taskId: string) {
        const events = this.visibleEvents(id)
        const runs = events.filter(e => e.type === 'run/start' && e.data.state.taskId === taskId)
        const latest = [...events].reverse().find(e => e.type === 'run/finish' && e.data.state.taskId === taskId)
        return { taskId, runIds: runs.map(e => e.type === 'run/start' ? e.data.state.runId : ''), continuations: Math.max(0, runs.length - 1),
            status: latest?.type === 'run/finish' ? latest.data.state.status : 'running', counters: this.taskCounters(id, taskId) }
    }
    taskCounters(id: string, taskId: string): Counters {
        const result = emptyCounters()
        for (const event of this.visibleEvents(id)) {
            if (event.type !== 'run/finish' || event.data.state.taskId !== taskId) continue
            for (const key of Object.keys(result) as (keyof Counters)[]) result[key] += (event.data.state.counters[key] ?? 0)
        }
        return result
    }

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

    append<K extends keyof EventData>(id: string, type: K, data: EventData[K], scope: { taskId?: string; runId?: string } = {}) {
        const session = this.get(id)

        const event = {
            version: 1 as const, sessionId: id, id: randomUUID(), ...(scope.taskId ? { taskId: scope.taskId } : {}), ...(scope.runId ? { runId: scope.runId } : {}),
            seq: session.events.length + 1,
            type,
            data: structuredClone(data),
            at: new Date().toISOString(),
        }
        session.events.push(event as SessionEvent)
        const store = this.#stores.get(id)
        if (store) {
            const pending = (this.#pending.get(id) ?? Promise.resolve()).then(() => store.append(event as SessionEvent))
            this.#pending.set(id, pending)
            void pending.catch(() => {})
        }

        return event
    }

    // Clear the session events but keep the meta data
    clear(id: string) {
        const old = this.get(id)
        if (this.latestRun(id)?.status === 'running') throw new Error('session is running')
        this.append(id, 'session/reset', { epoch: old.events.filter(e => e.type === 'session/reset').length + 1 })
    }

    // List all sessions with their metadata and creation time
    list() {
        return [...this.#sessions.values()]
    }

    // Derive messages from the session events for a given session ID
    deriveMessages(id: string, events = this.visibleEvents(id)) {
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
                    ...(data.reasoningContent ? { reasoning_content: data.reasoningContent } : {}),
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