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
    #projection?: (name: string, result: ToolResult, execution: Execution) => Promise<ToolResult>
    #authorize?: (tool: ToolDefinition, args: Arguments, execution: Execution) => Promise<void>
    #authorizationConfigured = false
    #capabilities?: ReadonlySet<string>
    #admission?: (execution: Execution) => Promise<void>
    setAdmission(admit: (execution: Execution) => Promise<void>) {
        if (this.#admission) throw new Error('tool admission already configured')
        this.#admission = admit
    }
    setCapabilities(names: readonly string[]) {
        if (this.#capabilities) throw new Error('tool capabilities already fixed')
        this.#capabilities = new Set(names)
    }
    #permitted(tool: ToolDefinition) { return !this.#capabilities || (this.#capabilities.has(tool.name) && tool.origin === 'builtin' && tool.effect === 'read') }

    setAuthorization(authorize: (tool: ToolDefinition, args: Arguments, execution: Execution) => Promise<void>) {
        if (this.#authorize) throw new Error('tool authorization already configured')
        this.#authorizationConfigured = true
        this.#authorize = authorize
        return () => { if (this.#authorize === authorize) this.#authorize = undefined }
    }

    setResultProjection(projection: (name: string, result: ToolResult, execution: Execution) => Promise<ToolResult>) {
        if (this.#projection) throw new Error('tool result projection already configured')
        this.#projection = projection
        return () => { if (this.#projection === projection) this.#projection = undefined }
    }

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
        return [...this.#tools.values()].filter(tool => this.#permitted(tool))
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
            if (this.#admission) try {
                await this.#admission({ ...exec, signal: exec.signal ?? new AbortController().signal })
            } catch { return { value: null, content: [{ type: 'text', text: 'ToolError: group admission rejected' }], isError: true } }
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
            toolSequence: exec.toolSequence,
            agent: exec.agent,
        }

        let result: ToolResult
        try {
            await this.#admission?.(execution)
            if (!this.#permitted(tool)) throw new Error('tool is forbidden by immutable role capabilities')
            if (this.#authorizationConfigured && !this.#authorize) throw new Error('tool authorization unavailable')
            await this.#authorize?.(tool, args, execution)
            execution.signal.throwIfAborted()
            const value = await tool.execute(args, execution)
            const content = tool.output?.render
                ? tool.output.render(args, value)
                : [{ type: 'text', text: toText(value) }]

            result = { value, content, isError: tool.output?.isError?.(value) ?? false }
            if (typeof tool.finalizeContent === 'function') {
                const finalized = await tool.finalizeContent(execution, result)
                if (finalized !== undefined) result = { ...result, content: finalized }
            }
        } catch (error: unknown) {
            result = {
                value: null,
                content: [{ type: 'text', text: `ToolError: ${tool.exposeErrors && error instanceof Error ? error.message : 'execution failed'}` }],
                isError: true,
            }
        }
        if (this.#projection) {
            try { return await this.#projection(name, result, execution) }
            catch { return { value: null, isError: true, content: [{ type: 'text', text: 'ToolError: result projection failed' }] } }
        }
        return result
    }

    renderResult(result: ToolResult) {
        return blocksToText(result.content)
    }
}
