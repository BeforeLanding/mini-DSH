const CANCELLED_RESULT = 'ToolError: the run was cancelled before this tool ran'

export class AgentLoopRuntime {
    constructor({ sessions, systemPrompt, tools, llm }) {
        this.sessions = sessions
        this.systemPrompt = systemPrompt
        this.tools = tools
        this.llm = llm
    }

    async run(agent, input, { signal, onReasoning, onContent, onToolCall, onToolResult } = {}) {
        const sessionId = agent.sessionId

        this.sessions.append(sessionId, 'user/message', { content: input })

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

            const messages = this.sessions.deriveMessages(sessionId)

            const response = await this.llm.chat(
                {
                    system,
                    messages,
                    tools: this.tools.schemas(),
                    signal,
                    onReasoning,
                    onContent,
                },
                agent.model,
            )

            const toolCalls = response.toolCalls ?? []

            if (toolCalls.length === 0) {
                const content = response.content ?? ''
                this.sessions.append(sessionId, 'assistant/message', { content })
                return content
            }

            this.sessions.append(sessionId, 'assistant/tool_calls', {
                content: response.content ?? null,
                reasoningContent: response.reasoningContent,
                toolCalls,
            })

            let cancelled = false

            for (const call of toolCalls) {
                cancelled ||= Boolean(signal?.aborted)

                if (cancelled) {
                    this.sessions.append(sessionId, 'tool/result', {
                        toolCallId: call.id,
                        name: call.name,
                        isError: true,
                        content: CANCELLED_RESULT,
                    })
                    continue
                }

                onToolCall?.(call)

                const result = await this.tools.execute(call.name, call.arguments, {
                    signal,
                    sessionId,
                    toolCallId: call.id,
                    agent,
                })

                const renderedContent = this.tools.renderResult(result)
                onToolResult?.({ ...result, renderedContent, name: call.name, toolCallId: call.id })

                this.sessions.append(sessionId, 'tool/result', {
                    toolCallId: call.id,
                    name: call.name,
                    isError: result.isError,
                    content: renderedContent,
                })
            }

            if (cancelled) {
                throw new Error('Agent run cancelled')
            }

        }
    }
}