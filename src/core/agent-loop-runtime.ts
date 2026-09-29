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

    async run(agent: Agent, input: string, { signal, onReasoning, onContent, onToolCall, onToolResult, budget }: RunOptions = {}) {
        const configured = { ...agent.budget, ...budget }
        const capacity = configured.contextWindowTokens ?? (configured.inputTargetTokens !== undefined ? this.llm.capacity(agent.model) : undefined)
        const policy = resolveBudget(capacity === undefined ? undefined : { contextWindowTokens: capacity }, agent.budget, budget)
        const sessionId = agent.sessionId

        const state = this.sessions.beginRun(sessionId, policy, typeof agent.model === 'string' ? agent.model : JSON.stringify(agent.model))
        const started = performance.now()
        const append: SessionRuntime['append'] = (id, type, data) => this.sessions.append(id, type, data, state)
        try {
        append(sessionId, 'user/message', { content: input })
        //step1: Append the user's input message to the session's event log, marking the start of the agent's reasoning process

        let step = 0

        while (true) {
            step += 1

            if (signal?.aborted) {
                throw new Error('Agent run cancelled')
            }

            const system = await this.systemPrompt.assemble({
                agent,
                sessionId,
                step,
            })
            //step2: Assemble the system prompt based on the current agent, session ID, and step number. This prompt will guide the agent's reasoning and decision-making process.

            const schemas = this.tools.schemas()
            const projection = new ContextBudgetRuntime().project(this.sessions.visibleEvents(sessionId), state.taskId,
                { system, tools: schemas, maxOutputTokens: policy.maxOutputTokens }, policy, events => this.sessions.deriveMessages(sessionId, events))
            const { messages, estimatedInputTokens } = projection
            state.removedTaskIds = [...new Set([...state.removedTaskIds, ...projection.removedTaskIds])]
            append(sessionId, 'context/projection', { estimatedInputTokens, reservedOutputTokens: projection.reservedOutputTokens, safetyMarginTokens: projection.safetyMarginTokens, removedTaskIds: projection.removedTaskIds })
            state.estimatedInputTokens = estimatedInputTokens
            state.counters.modelRequests++
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
            await this.sessions.flush(sessionId)
            const journal = new StreamJournal(requestId, data => append(sessionId, 'model/fragment', data))
            const response = await this.llm.chat(
                {
                    maxOutputTokens: policy.maxOutputTokens,
                    system,
                    messages,
                    tools: schemas,
                    signal,
                    onReasoning: chunk => { journal.add('reasoning', chunk); onReasoning?.(chunk) },
                    onContent: chunk => { journal.add('content', chunk); onContent?.(chunk) },
                },
                agent.model,
            ).catch(error => {
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

            if (toolCalls.length === 0) {
                const content = response.content ?? ''
                append(sessionId, 'assistant/message', { content, reasoningContent: response.reasoningContent })
                state.counters.activeDurationMs = performance.now() - started
                this.sessions.finishRun(state, 'completed')
                await this.sessions.flush(sessionId)
                return content
            }//step4: If the LLM's response does not include any tool calls, append the assistant's message to the session and return the content. This indicates that the agent has completed its reasoning without needing to invoke any tools.

            append(sessionId, 'assistant/tool_calls', {
                content: response.content ?? null,
                reasoningContent: response.reasoningContent,
                toolCalls,
            })

            let cancelled = false

            for (const call of toolCalls) {
                cancelled ||= Boolean(signal?.aborted)

                if (cancelled) {
                    append(sessionId, 'tool/result', {
                        toolCallId: call.id,
                        name: call.name,
                        isError: true,
                        content: CANCELLED_RESULT,
                        status: 'skipped',
                    })
                    continue
                }

                state.counters.toolCalls++
                append(sessionId, 'tool/start', { taskId: state.taskId, runId: state.runId, toolCallId: call.id, name: call.name })
                await this.sessions.flush(sessionId)
                onToolCall?.(call)

                const result = await this.tools.execute(call.name, call.arguments, {
                    signal,
                    sessionId,
                    toolCallId: call.id,
                    agent,
                })//step5: For each tool call generated by the LLM, check if the run has been cancelled. If not, invoke the corresponding tool with the provided arguments and execution context. Capture the result of the tool execution, which may include success or error information.

                const renderedContent = this.tools.renderResult(result)
                onToolResult?.({ ...result, renderedContent, name: call.name, toolCallId: call.id })

                append(sessionId, 'tool/result', {
                    toolCallId: call.id,
                    name: call.name,
                    isError: result.isError,
                    content: renderedContent,
                    status: 'completed',
                })
            }
            //step6: After executing each tool, render the result for display, invoke any provided callbacks for tool results, and append the tool's result to the session's event log. This allows the agent to continue its reasoning based on the outcomes of the tool executions.

            if (cancelled) {
                throw new Error('Agent run cancelled')
            }

        }
        } catch (error) {
            state.counters.activeDurationMs = performance.now() - started
            this.sessions.finishRun(state, error instanceof BudgetStop ? error.reason : signal?.aborted ? 'cancelled' : 'error')
            await this.sessions.flush(sessionId)
            throw error
        }
    }
}
