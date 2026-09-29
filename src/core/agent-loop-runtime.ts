import { pendingTools } from './pending-tools.js'
import { RunBudgetRuntime } from './run-budget-runtime.js'
import type { Clock } from './run-budget-runtime.js'
import { ContextBudgetRuntime } from './context-runtime.js'
import { estimateInput, estimateUsage } from './token-estimator.js'
import { StreamJournal } from './stream-journal.js'
import { ModelStreamError } from './model-error.js'
import type { Usage } from './budget.js'
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
        const append: SessionRuntime['append'] = (id, type, data) => this.sessions.append(id, type, data, state)
        try {
        if (input !== undefined) append(sessionId, 'user/message', { content: input })
        //step1: Append the user's input message to the session's event log, marking the start of the agent's reasoning process

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
            //step2: Assemble the system prompt based on the current agent, session ID, and step number. This prompt will guide the agent's reasoning and decision-making process.

            control.check()
            const schemas = this.tools.schemas()
            const projection = new ContextBudgetRuntime().project(this.sessions.visibleEvents(sessionId), state.taskId,
                { system, tools: schemas, maxOutputTokens: policy.maxOutputTokens }, policy, events => this.sessions.deriveMessages(sessionId, events))
            const { messages, estimatedInputTokens } = projection
            state.removedTaskIds = [...new Set([...state.removedTaskIds, ...projection.removedTaskIds])]
            control.check()
            const maxOutputTokens = control.outputAllowance(estimatedInputTokens)
            const reservedOutputTokens = maxOutputTokens ?? 0
            append(sessionId, 'context/projection', { estimatedInputTokens, reservedOutputTokens, safetyMarginTokens: projection.safetyMarginTokens, removedTaskIds: projection.removedTaskIds })
            if ((policy.inputTargetTokens !== undefined && estimatedInputTokens > policy.inputTargetTokens) ||
                (policy.contextWindowTokens !== undefined && estimatedInputTokens + reservedOutputTokens + projection.safetyMarginTokens > policy.contextWindowTokens)) throw new BudgetStop('context_overflow', state)
            state.estimatedInputTokens = estimatedInputTokens
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
            //step3: Use the LLM to generate a response based on the system prompt, the derived messages, available tools, and any provided callbacks for reasoning and content. The model used is specified by the agent's model selection.

            const toolCalls = response.toolCalls ?? []
            if (!toolCalls.length) control.check()

            if (toolCalls.length === 0) {
                const content = response.content ?? ''
                append(sessionId, 'assistant/message', { content, reasoningContent: response.reasoningContent })
                if (policy.maxTotalTokens !== undefined && state.counters.totalTokens > policy.maxTotalTokens) throw new BudgetStop('token_budget', state)
                state.counters.approvalDurationMs = control.approvalDurationMs
                state.counters.activeDurationMs = control.activeDurationMs
                this.sessions.finishRun(state, 'completed')
                await this.sessions.flush(sessionId)
                return content
            }//step4: If the LLM's response does not include any tool calls, append the assistant's message to the session and return the content. This indicates that the agent has completed its reasoning without needing to invoke any tools.

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
                }))//step5: For each tool call generated by the LLM, check if the run has been cancelled. If not, invoke the corresponding tool with the provided arguments and execution context. Capture the result of the tool execution, which may include success or error information.

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
            //step6: After executing each tool, render the result for display, invoke any provided callbacks for tool results, and append the tool's result to the session's event log. This allows the agent to continue its reasoning based on the outcomes of the tool executions.

            if (cancelled) control.check()
            if (toolsExhausted) throw new BudgetStop('max_tool_calls', state)

        }
        } catch (error) {
            const events = this.sessions.visibleEvents(sessionId)
            for (const { call, scope } of pendingTools(events)) {
                if (scope.runId !== state.runId) continue
                const started = enteredTools.has(`${scope.seq}/${call.id}`)
                append(sessionId, 'tool/result', { toolCallId: call.id, name: call.name, isError: true, status: started ? 'unknown' : 'skipped',
                    content: 'ToolError: ' + (started ? 'unknown outcome' : 'skipped') + ' after ' + (error instanceof BudgetStop ? error.reason : 'error') })
            }
            state.counters.approvalDurationMs = control.approvalDurationMs
                state.counters.activeDurationMs = control.activeDurationMs
            this.sessions.finishRun(state, control.stopReason ?? (error instanceof BudgetStop ? error.reason : 'error'))
            await this.sessions.flush(sessionId)
            throw error
        } finally { control.dispose() }
    }
}
