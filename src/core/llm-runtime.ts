import { isRecord } from './event-store.js'
import { validUsage } from './event-validation.js'
import { ModelStreamError } from './model-error.js'
import type { Adapter, ChatRequest, ChatResponse, ModelSelection } from './contracts.js'
export class LlmRuntime {
    #providers = new Map<string, Adapter>()
    #defaultSelection: string | null = null

    register(provider: string, adapter: Adapter, { defaultModel }: { defaultModel?: string } = {}) {
        if (this.#providers.has(provider)) {
            throw new Error(`duplicate LLM provider: ${provider}`)
        }

        this.#providers.set(provider, adapter)

        if (!this.#defaultSelection) {
            const model = defaultModel ?? adapter.models?.[0]
            if (model) this.#defaultSelection = `${provider}/${model}`
        }

        let disposed = false
        return () => {
            if (disposed) return
            disposed = true
            if (this.#providers.get(provider) === adapter) {
                this.#providers.delete(provider)
            }
        }
    }

    capacity(selection: ModelSelection) {
        const { provider, model } = normalizeSelection(selection)
        return this.#providers.get(provider)?.capabilities?.[model]?.contextWindowTokens
    }
    models() {
        const out: string[] = []
        for (const [provider, adapter] of this.#providers) {
            for (const model of adapter.models ?? []) {
                out.push(`${provider}/${model}`)
            }
        }
        return out
    }

    defaultSelection() {
        return this.#defaultSelection
    }

    has(selection: ModelSelection) {
        const { provider, model } = normalizeSelection(selection)
        const adapter = this.#providers.get(provider)
        if (!adapter) return false
        if (!adapter.models?.length) return true
        return adapter.models.includes(model)
    }

    async chat(request: ChatRequest, selection: ModelSelection = this.#defaultSelection): Promise<ChatResponse> {
        const { provider, model } = normalizeSelection(selection)
        const adapter = this.#providers.get(provider)

        if (!adapter) {
            throw new Error(`no LLM provider: ${provider}`)
        }

        const response = await adapter.chat({ ...request, model })
        const calls = response?.toolCalls ?? []
        if (!isRecord(response) || (response.content !== undefined && typeof response.content !== 'string') ||
            (response.reasoningContent !== undefined && typeof response.reasoningContent !== 'string') ||
            (response.complete !== undefined && typeof response.complete !== 'boolean') || (response.finishReason !== undefined && typeof response.finishReason !== 'string') ||
            (response.usage !== undefined && !validUsage(response.usage)) || !Array.isArray(calls) ||
            calls.some(call => !isRecord(call) || typeof call.id !== 'string' || !call.id || typeof call.name !== 'string' || !call.name || (call.arguments !== undefined && !isRecord(call.arguments))) ||
            new Set(calls.map(call => call.id)).size !== calls.length) {
            throw new ModelStreamError('invalid model response/tool calls/usage', { content: typeof response?.content === 'string' ? response.content : '', complete: false })
        }
        return response
    }
}

function normalizeSelection(selection: ModelSelection) {
    if (!selection) throw new Error('no model selected')

    if (typeof selection === 'object') {
        if (!selection.provider || !selection.model) {
            throw new Error('model selection must include provider and model')
        }
        return selection
    }

    const slash = String(selection).indexOf('/')
    if (slash <= 0 || slash === String(selection).length - 1) {
        throw new Error(`invalid model selection: ${selection}, expected provider/model`)
    }

    return {
        provider: String(selection).slice(0, slash),
        model: String(selection).slice(slash + 1),
    }
}
