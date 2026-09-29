import { pendingTools } from './pending-tools.js'
import { RunBudgetRuntime } from './run-budget-runtime.js'
import type { Clock } from './run-budget-runtime.js'
import { ContextBudgetRuntime } from './context-runtime.js'
import { estimateInput, estimateUsage } from './token-estimator.js'
import { StreamJournal } from './stream-journal.js'
import { ModelStreamError } from './model-error.js'
import type { Usage, StopReason } from './budget.js'
import { randomUUID } from 'node:crypto'
import { BudgetStop } from './budget.js'
import { resolveBudget } from './budget.js'
import type { Agent, RunOptions } from './contracts.js'
import type { SessionRuntime } from './session-runtime.js'
import type { SystemPromptRuntime } from './system-prompt-runtime.js'
import type { ToolRuntime } from './tool-runtime.js'
import type { LlmRuntime } from './llm-runtime.js'
const CANCELLED_RESULT = 'ToolError: the run was cancelled before this tool ran'

export class AgentLoopRuntime {
    sessions: Pick<SessionRuntime, keyof SessionRuntime>
    systemPrompt: Pick<SystemPromptRuntime, "assemble">
    tools: Pick<ToolRuntime, "schemas" | "execute" | "renderResult">
    llm: Pick<LlmRuntime, "chat" | "capacity">
    constructor({ sessions, systemPrompt, tools, llm }: { sessions: Pick<SessionRuntime, keyof SessionRuntime>; systemPrompt: Pick<SystemPromptRuntime, "assemble">; tools: Pick<ToolRuntime, "schemas" | "execute" | "renderResult">; llm: Pick<LlmRuntime, "chat" | "capacity"> }) {
        this.sessions = sessions
        this.systemPrompt = systemPrompt
        this.tools = tools
        this.llm = llm
    }

    clock?: Clock
    budget?: import('./budget.js').BudgetPolicy
    async run(agent: Agent, input: string | undefined, { signal, onReasoning, onContent, onToolCall, onToolResult, budget }: RunOptions = {}) {
        const configured = { ...this.budget, ...agent.budget, ...budget }
        const capacity = configured.contextWindowTokens ?? (configured.inputTargetTokens !== undefined ? this.llm.capacity(agent.model) : undefined)
        const policy = resolveBudget(capacity === undefined ? undefined : { contextWindowTokens: capacity }, this.budget, agent.budget, budget)
        const sessionId = agent.sessionId

        const state = this.sessions.beginRun(sessionId, policy, typeof agent.model === 'string' ? agent.model : JSON.stringify(agent.model), input === undefined)
        const control = new RunBudgetRuntime(policy, state, signal, this.clock)
        const enteredTools = new Set<string>()
        let terminalStatus: StopReason | undefined
        const observeCommit = (confirmed: boolean, status: StopReason = terminalStatus!) => {
            state.counters.approvalDurationMs = control.approvalDurationMs
            state.counters.activeDurationMs = control.activeDurationMs
            this.sessions.observeTerminalCommit(state, terminalStatus!, confirmed, status)
        }
        const append: SessionRuntime['append'] = (id, type, data) => this.sessions.append(id, type, data, state)
        try {
        if (input !== undefined) append(sessionId, 'user/message', { content: input })

        let step = 0

        while (true) {
            step += 1

            control.check()
            if (policy.maxModelRequests !== undefined && state.counters.modelRequests >= policy.maxModelRequests) throw new BudgetStop('max_steps', state)

            const system = await control.wait(() => this.systemPrompt.assemble({
                agent,
                sessionId,
                step,
            }))

            control.check()
            const schemas = this.tools.schemas()
            const projection = new ContextBudgetRuntime().project(this.sessions.visibleEvents(sessionId), state.taskId,
                { system, tools: schemas, maxOutputTokens: policy.maxOutputTokens }, policy, events => this.sessions.deriveMessages(sessionId, events), inputTokens => control.outputAllowance(inputTokens))
            const { messages, estimatedInputTokens } = projection
            state.removedTaskIds = [...new Set([...state.removedTaskIds, ...projection.removedTaskIds])]
            control.check()
            const maxOutputTokens = control.outputAllowance(estimatedInputTokens)
            const reservedOutputTokens = maxOutputTokens ?? 0
            state.estimatedInputTokens = estimatedInputTokens
            append(sessionId, 'context/projection', { estimatedInputTokens, reservedOutputTokens, safetyMarginTokens: projection.safetyMarginTokens, removedTaskIds: projection.removedTaskIds })
            if ((policy.inputTargetTokens !== undefined && estimatedInputTokens > policy.inputTargetTokens) ||
                (policy.contextWindowTokens !== undefined && estimatedInputTokens + reservedOutputTokens + projection.safetyMarginTokens > policy.contextWindowTokens)) throw new BudgetStop('context_overflow', state)
            const requestId = randomUUID()
            append(sessionId, 'model/start', { taskId: state.taskId, runId: state.runId, requestId, estimatedInputTokens })
            const settle = (usage?: Usage) => {
                if (!usage) return
                state.usage.push(usage)
                state.counters.inputTokens += usage.inputTokens
                state.counters.outputTokens += usage.outputTokens
                state.counters.totalTokens += usage.totalTokens
                append(sessionId, 'model/usage', { taskId: state.taskId, runId: state.runId, requestId, usage })
            }
            await control.wait(() => this.sessions.flush(sessionId))
            control.check()
            state.counters.modelRequests++
            const journal = new StreamJournal(requestId, data => append(sessionId, 'model/fragment', data))
            const response = await control.wait(() => this.llm.chat(
                {
                    maxOutputTokens,
                    system,
                    messages,
                    tools: schemas,
                    signal: control.signal,
                    onReasoning: chunk => { if (control.signal.aborted || journal.closed) return; journal.add('reasoning', chunk); onReasoning?.(chunk) },
                    onContent: chunk => { if (control.signal.aborted || journal.closed) return; journal.add('content', chunk); onContent?.(chunk) },
                },
                agent.model,
            ), policy.requestTimeoutMs ?? 180_000).catch(error => {
                journal.close()
                const partial = error instanceof ModelStreamError ? error.partial : { content: journal.content, reasoningContent: journal.reasoningContent, usage: undefined }
                settle(partial.usage ?? estimateUsage(estimatedInputTokens, partial))
                append(sessionId, 'model/end', { requestId, complete: false })
                throw error
            }).finally(() => journal.close())
            settle(response.usage ?? estimateUsage(estimatedInputTokens, response))
            append(sessionId, 'model/end', { requestId, complete: response.complete !== false, finishReason: response.finishReason })
            if (response.complete === false) throw new BudgetStop(response.finishReason === 'length' ? 'output_limit' : 'error', state)

            const toolCalls = response.toolCalls ?? []
            if (!toolCalls.length) control.check()

            if (toolCalls.length === 0) {
                const content = response.content ?? ''
                append(sessionId, 'assistant/message', { content, reasoningContent: response.reasoningContent })
                if (policy.maxTotalTokens !== undefined && state.counters.totalTokens > policy.maxTotalTokens) throw new BudgetStop('token_budget', state)
                await control.wait(() => this.sessions.flush(sessionId))
                control.check()
                state.counters.approvalDurationMs = control.approvalDurationMs
                state.counters.activeDurationMs = control.activeDurationMs
                terminalStatus = 'completed'
                this.sessions.finishRun(state, terminalStatus)
                await control.wait(() => this.sessions.flush(sessionId), policy.finalizationTimeoutMs ?? 5_000, 'timeout')
                control.check()
                observeCommit(true)
                return content
            }

            const batch = append(sessionId, 'assistant/tool_calls', {
                content: response.content ?? null,
                reasoningContent: response.reasoningContent,
                toolCalls,
            })

            control.check()
            if (policy.maxModelRequests !== undefined && state.counters.modelRequests >= policy.maxModelRequests) throw new BudgetStop('max_steps', state)
            if (policy.maxTotalTokens !== undefined && state.counters.totalTokens >= policy.maxTotalTokens) {
                const reason = policy.maxToolCalls !== undefined && state.counters.toolCalls >= policy.maxToolCalls ? 'max_tool_calls' : 'token_budget'
                throw new BudgetStop(reason, state)
            }
            let cancelled = false
            let toolsExhausted = false

            for (const call of toolCalls) {
                cancelled ||= Boolean(control.signal.aborted)

                const exhausted = policy.maxToolCalls !== undefined && state.counters.toolCalls >= policy.maxToolCalls
                toolsExhausted ||= exhausted
                if (cancelled || exhausted) {
                    append(sessionId, 'tool/result', {
                        toolCallId: call.id,
                        name: call.name,
                        isError: true,
                        content: cancelled ? CANCELLED_RESULT : 'ToolError: skipped because max_tool_calls budget was exhausted',
                        status: 'skipped',
                    })
                    continue
                }

                onToolCall?.(call)
                control.check()
                append(sessionId, 'tool/start', { taskId: state.taskId, runId: state.runId, toolCallId: call.id, name: call.name })
                await control.wait(() => this.sessions.flush(sessionId))
                control.check()
                state.counters.toolCalls++
                enteredTools.add(`${batch.seq}/${call.id}`)
                const result = await control.wait(() => this.tools.execute(call.name, call.arguments, {
                    signal: control.signal,
                    sessionId,
                    toolCallId: call.id,
                    agent,
                    approval: work => control.approve(work),
                }))

                const renderedContent = this.tools.renderResult(result)

                append(sessionId, 'tool/result', {
                    toolCallId: call.id,
                    name: call.name,
                    isError: result.isError,
                    content: renderedContent,
                    status: 'completed',
                })
                await this.sessions.flush(sessionId)
                onToolResult?.({ ...result, renderedContent, name: call.name, toolCallId: call.id })
            }

            if (cancelled) control.check()
            if (toolsExhausted) throw new BudgetStop('max_tool_calls', state)

        }
        } catch (error) {
            if (terminalStatus !== undefined) {
                observeCommit(false, control.stopReason ?? (error instanceof BudgetStop ? error.reason : 'error'))
                throw error
            }
            const events = this.sessions.visibleEvents(sessionId)
            for (const { call, scope } of pendingTools(events)) {
                if (scope.runId !== state.runId) continue
                const started = enteredTools.has(`${scope.seq}/${call.id}`)
                append(sessionId, 'tool/result', { toolCallId: call.id, name: call.name, isError: true, status: started ? 'unknown' : 'skipped',
                    content: 'ToolError: ' + (started ? 'unknown outcome' : 'skipped') + ' after ' + (error instanceof BudgetStop ? error.reason : 'error') })
            }
            state.counters.approvalDurationMs = control.approvalDurationMs
                state.counters.activeDurationMs = control.activeDurationMs
            terminalStatus = control.stopReason ?? (error instanceof BudgetStop ? error.reason : 'error')
            this.sessions.finishRun(state, terminalStatus)
            try {
                await control.finalize(() => this.sessions.flush(sessionId))
                observeCommit(true)
            } catch (commitError) {
                observeCommit(false, terminalStatus)
                if (!(commitError instanceof BudgetStop)) throw commitError
            }
            throw error
        } finally { control.dispose() }
    }
}
