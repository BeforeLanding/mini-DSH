import type { Arguments, Execution, ContentBlock, ToolDefinition, ToolResult } from './contracts.js'
function toText(value: unknown): string {
    if (typeof value === 'string') return value
    return JSON.stringify(value, null, 2) ?? String(value)
}

function blocksToText(blocks: ContentBlock[]) {
    if (!Array.isArray(blocks)) return toText(blocks)
    return blocks
        .map((block) => {
            if (block?.type === 'text') return block.text ?? ''
            return toText(block)
        })
        .filter(Boolean)
        .join('\n')
}

export class ToolRuntime {
    #tools = new Map<string, ToolDefinition>()

    register(definition: ToolDefinition) {
        if (!definition?.name) throw new Error('tool.name is required')
        if (typeof definition.execute !== 'function')
            throw new Error(`tool is missing execute(): ${definition.name}`)
        if (this.#tools.has(definition.name))
            throw new Error(`duplicate tool name: ${definition.name}`)

        this.#tools.set(definition.name, definition)
        let disposed = false

        return () => {
            if (disposed) return
            disposed = true
            if (this.#tools.get(definition.name) === definition) this.#tools.delete(definition.name)
        }
    }

    get(name: string) {
        return this.#tools.get(name)
    }

    list() {
        return [...this.#tools.values()]
    }

    schemas() {
        return this.list().map((tool) => ({
            type: 'function' as const,
            function: {
                name: tool.name,
                description: tool.description ?? '',
                parameters: tool.parameters ?? { type: 'object', properties: {} },
            },
        }))
    }

    async execute(name: string, args: Arguments = {}, exec: Partial<Execution> = {}): Promise<ToolResult> {
        const tool = this.get(name)
        if (!tool) {
            return {
                value: null,
                content: [{ type: 'text', text: `Unknown tool: ${name}` }],
                isError: true,
            }
        }

        const execution = {
            approval: exec.approval,
            signal: exec.signal ?? new AbortController().signal,
            sessionId: exec.sessionId,
            toolCallId: exec.toolCallId,
            agent: exec.agent,
        }

        try {
            const value = await tool.execute(args, execution)
            const content = tool.output?.render
                ? tool.output.render(args, value)
                : [{ type: 'text', text: toText(value) }]

            let result = { value, content, isError: false }
            if (typeof tool.finalizeContent === 'function') {
                const finalized = await tool.finalizeContent(execution, result)
                if (finalized !== undefined) result = { ...result, content: finalized }
            }
            return result
        } catch (error: unknown) {
            return {
                value: null,
                content: [{ type: 'text', text: `ToolError: ${error instanceof Error ? error.message : String(error)}` }],
                isError: true,
            }
        }
    }

    renderResult(result: ToolResult) {
        return blocksToText(result.content)
    }
}