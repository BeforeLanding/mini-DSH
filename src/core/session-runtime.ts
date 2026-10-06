import { validatePayload } from './event-validation.js'
import { isRecord } from './event-store.js'
import { pendingTools } from './pending-tools.js'
import { estimateUsage } from './token-estimator.js'
import path from 'node:path'
import { parseLog } from './event-store.js'
import type { EventStore } from './event-store.js'
import { emptyCounters } from './budget.js'
import type { BudgetPolicy, RunState, StopReason, Counters } from './budget.js'
import type { Arguments, EventData, Session, SessionEvent } from './contracts.js'
import { randomUUID } from 'node:crypto'
import { deriveEventMessage, surfaceSeqs } from './compaction-plan.js'

export class SessionRuntime {
    #stores = new Map<string, EventStore>()
    #confirmed = new Map<string, number>()
    #storeErrors = new Map<string, unknown>()
    #pending = new Map<string, Promise<void>>()
    #terminalCommits = new Map<string, RunState>()

    observeTerminalCommit(state: RunState, terminalStatus: StopReason, confirmed: boolean, status: StopReason = terminalStatus) {
        state.status = status
        state.terminalCommit = { status: confirmed ? 'confirmed' : 'uncertain', terminalStatus, activeDurationMs: state.counters.activeDurationMs }
        this.#terminalCommits.set(state.runId, structuredClone(state))
    }
    
    attachStore(id: string, store: EventStore, existing = false) {
        if (this.#stores.has(id)) throw new Error('session already has a store')
        const session = this.get(id)
        this.#stores.set(id, store)
        this.#confirmed.set(id, existing ? session.events.length : 0)
        let pending = Promise.resolve()
        if (!existing) for (const event of session.events) pending = pending.then(async () => { await store.append(event); this.#confirmed.set(id, event.seq) })
        this.#pending.set(id, pending)
        void pending.catch(error => { this.#storeErrors.set(id, error) })
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
        // §9.1：崩溃窗口里的未闭合尝试一律补上配对结束事件——**每一个** summary-start 都要有 end。
        // 补什么由摘要正文是否已经落盘决定：写下 context/summary 的那次尝试事实上生效了（投影认它），
        // 补 applied 才是如实记录；连正文都没有的才补 declined/unclosed。这样两条不变量同时成立——
        // 括号必然闭合，且闭合后的结论与日志里真正发生了什么一致。
        for (const event of visible) {
            if (event.type !== 'context/summary-start') continue
            if (visible.some(candidate => candidate.type === 'context/summary-end' && candidate.data.startSeq === event.seq)) continue
            const outcome: EventData['context/summary-end']['outcome'] = visible.some(candidate => candidate.type === 'context/summary' && candidate.data.startSeq === event.seq)
                ? { kind: 'applied' }
                : { kind: 'declined', reason: 'unclosed' }
            this.append(id, 'context/summary-end', { startSeq: event.seq, outcome }, event)
        }
        for (const event of visible) {
            if (event.type !== 'model/start' || visible.some(e => e.type === 'model/usage' && e.data.requestId === event.data.requestId)) continue
            const chunks = visible.filter(e => e.type === 'model/fragment' && e.data.requestId === event.data.requestId)
            const content = chunks.map(e => e.type === 'model/fragment' ? e.data.content : '').join('')
            const reasoningContent = chunks.map(e => e.type === 'model/fragment' ? e.data.reasoningContent : '').join('')
            this.append(id, 'model/usage', { taskId: event.data.taskId, runId: event.data.runId, requestId: event.data.requestId,
                usage: estimateUsage(event.data.estimatedInputTokens ?? 256, { content, reasoningContent }) }, event)
            if (!visible.some(e => e.type === 'model/end' && e.data.requestId === event.data.requestId)) this.append(id, 'model/end', { requestId: event.data.requestId, complete: false }, event)
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
    confirmedEvents(id: string) {
        const events = this.visibleEvents(id)
        return this.#stores.has(id) ? events.filter(event => event.seq <= (this.#confirmed.get(id) ?? 0)) : events
    }
    configuration(id: string) {
        const event = [...this.visibleEvents(id)].reverse().find(e => e.type === 'session/config')
        return event?.type === 'session/config' ? structuredClone(event.data) : undefined
    }
    latestRun(id: string): RunState | undefined {
        const events = this.visibleEvents(id)
        return this.#foldLatestRun(id, events, [...events].reverse().find(e => e.type === 'run/start'))
    }
    // 续跑要承接的是**最后一次真正干活的 run**，不是最近一次 run：/compact 会追加一条维护型 run
    // （maintenance，见 beginMaintenanceRun），它不承接任何工作。若让它当了 previous，
    // 「预算停止之后还能续跑」会退化成「任务已完成」。
    #latestWorkingRun(id: string) {
        const events = this.visibleEvents(id)
        return this.#foldLatestRun(id, events, [...events].reverse().find(e => e.type === 'run/start' && !e.data.state.maintenance))
    }
    #foldLatestRun(id: string, events: SessionEvent[], begin: SessionEvent | undefined): RunState | undefined {
        if (begin?.type !== 'run/start') return undefined
        const end = [...events].reverse().find(e => e.type === 'run/finish' && e.data.state.runId === begin.data.state.runId)
        if (end?.type === 'run/finish') {
            const observed = this.#terminalCommits.get(begin.data.state.runId)
            if (observed) return structuredClone(observed)
            const state = structuredClone(end.data.state)
            if (this.#stores.has(id) && end.seq > (this.#confirmed.get(id) ?? 0)) state.status = this.#storeErrors.has(id) ? 'error' : 'running'
            return state
        }
        const state = structuredClone(begin.data.state)
        for (const event of events) {
            if (event.runId !== state.runId) continue
            if (event.type === 'context/projection') {
                state.removedTaskIds = [...new Set([...state.removedTaskIds, ...event.data.removedTaskIds])]
                state.estimatedInputTokens = event.data.estimatedInputTokens
            }
            if (event.type === 'model/start') state.counters.modelRequests++
            if (event.type === 'tool/start') state.counters.toolCalls++
            if (event.type === 'model/usage') {
                state.usage.push(event.data.usage)
                state.counters.inputTokens += event.data.usage.inputTokens
                state.counters.outputTokens += event.data.usage.outputTokens
                state.counters.totalTokens += event.data.usage.totalTokens
            }
        }
        if (this.#storeErrors.has(id)) state.status = 'error'
        return state
    }
    beginRun(id: string, policy: Readonly<BudgetPolicy>, model: string, continuing = false): RunState {
        if (this.#storeErrors.has(id)) throw new Error('session storage failed; close and verify the log before resuming', { cause: this.#storeErrors.get(id) })
        if (this.latestRun(id)?.terminalCommit?.status === 'uncertain') throw new Error('terminal commit uncertain; close and restore the session log before resuming')
        if (this.latestRun(id)?.status === 'running') throw new Error('session is already running')
        const previous = continuing ? this.#latestWorkingRun(id) : this.latestRun(id)
        if (continuing) {
            if (!previous) throw new Error('no task to continue')
            if (previous.status === 'completed') throw new Error('task already completed')
            const unknown = this.visibleEvents(id).some(e => e.taskId === previous.taskId && e.type === 'tool/result' && e.data.status === 'unknown')
            if (unknown) throw new Error('unknown tool outcome; verify side effects before starting a new task; automatic continuation is blocked')
            const files = this.confirmedEvents(id).filter(e => e.taskId === previous.taskId)
            if (files.some(e => e.type === 'file/change' && !files.some(result => result.type === 'file/change-result' && result.data.changeId === e.data.changeId))) throw new Error('unknown file edit outcome; verify side effects before starting a new task; automatic continuation is blocked')
            const contextKeys = ['contextWindowTokens', 'inputTargetTokens', 'maxOutputTokens', 'safetyMarginTokens'] as const
            if (previous.status === 'context_overflow' && contextKeys.every(key => policy[key] === previous.policy[key]) && model === previous.model) throw new Error('context_overflow cannot continue with unchanged context configuration')
        }
        const state: RunState = { sessionId: id, taskId: continuing ? previous!.taskId : randomUUID(), runId: randomUUID(), model,
            ...(continuing ? { previousRunId: previous!.runId } : {}),
            policy, counters: emptyCounters(), status: 'running', usage: [], removedTaskIds: [] }
        this.append(id, 'run/start', { state }, state)
        return state
    }
    // NX-34：维护型 run。它复用当前 task——压缩要压的正是这个 task 的历史，另开一个任务只会让旧历史
    // 变成「可免费裁剪的旧任务」，那就不需要压缩了——但**不**承接任何待办工作：只允许记账与投影，
    // 不派发工具、也不继续干活。所以 beginRun 里三道为「续跑工作」设的守卫在这里都不成立，保留它们
    // 只会让 /compact 在任务刚做完时恰好被拒，而那一刻正是最该压缩的时候。保留的是三道与「这段 run
    // 能不能被安全记账」有关的检查。
    // 它刻意不写 previousRunId：维护型 run 不进续跑链，`latestWorkingRun` 会跳过它。
    beginMaintenanceRun(id: string, policy: Readonly<BudgetPolicy>, model: string): RunState {
        if (this.#storeErrors.has(id)) throw new Error('session storage failed; close and verify the log before resuming', { cause: this.#storeErrors.get(id) })
        if (this.latestRun(id)?.terminalCommit?.status === 'uncertain') throw new Error('terminal commit uncertain; close and restore the session log before resuming')
        if (this.latestRun(id)?.status === 'running') throw new Error('session is already running')
        const previous = this.#latestWorkingRun(id)
        const state: RunState = { sessionId: id, taskId: previous?.taskId ?? randomUUID(), runId: randomUUID(), model,
            maintenance: true, policy, counters: emptyCounters(), status: 'running', usage: [], removedTaskIds: [] }
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
        const lastRun = runs.at(-1)
        const latest = lastRun?.type === 'run/start' ? [...events].reverse().find(e => e.type === 'run/finish' && e.data.state.runId === lastRun.data.state.runId) : undefined
        const current = this.latestRun(id)
        return { taskId, runIds: runs.map(e => e.type === 'run/start' ? e.data.state.runId : ''), continuations: Math.max(0, runs.length - 1),
            status: current?.taskId === taskId ? current.status : latest?.type === 'run/finish' ? latest.data.state.status : 'running', counters: this.taskCounters(id, taskId) }
    }
    taskCounters(id: string, taskId: string): Counters {
        const result = emptyCounters()
        for (const event of this.visibleEvents(id)) {
            if (event.type !== 'run/finish' || event.data.state.taskId !== taskId) continue
            const counters = this.#terminalCommits.get(event.data.state.runId)?.counters ?? event.data.state.counters
            for (const key of Object.keys(result) as (keyof Counters)[]) result[key] += (counters[key] ?? 0)
        }
        return result
    }


    create(meta: Arguments = {}) {
        const id = randomUUID()

        const session: Session = {
            id,
            meta: { ...meta },
            events: [],
            createdAt: new Date().toISOString(),
        }

        this.#sessions.set(id, session)
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
            data: JSON.parse(JSON.stringify(data)) as EventData[K],
            at: new Date().toISOString(),
        }
        if (!isRecord(event.data)) throw new Error('event data must be a JSON object')
        validatePayload(type, event.data)
        session.events.push(event as SessionEvent)
        const store = this.#stores.get(id)
        if (store) {
            const pending = (this.#pending.get(id) ?? Promise.resolve()).then(async () => { await store.append(event as SessionEvent); this.#confirmed.set(id, event.seq) })
            this.#pending.set(id, pending)
            void pending.catch(error => { this.#storeErrors.set(id, error) })
        }

        return event
    }

    clear(id: string) {
        const old = this.get(id)
        if (this.latestRun(id)?.status === 'running') throw new Error('session is running')
        if (this.latestRun(id)?.terminalCommit?.status === 'uncertain') throw new Error('terminal commit uncertain; close and restore the session log before reset')
        this.append(id, 'session/reset', { epoch: old.events.filter(e => e.type === 'session/reset').length + 1 })
    }

    list() {
        return [...this.#sessions.values()]
    }

    deriveMessages(id: string, events = this.visibleEvents(id)) {
        const bySeq = new Map(events.map(event => [event.seq, event]))
        return surfaceSeqs(events).flatMap(seq => {
            const event = bySeq.get(seq)
            const message = event ? deriveEventMessage(event) : undefined
            return message ? [message] : []
        })
    }
}
