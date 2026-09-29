import type { Adapter, ChatRequest, ModelSelection } from './contracts.js'
export class LlmRuntime {
    #providers = new Map<string, Adapter>()
    #defaultSelection: string | null = null

    // Register a new LLM provider with its corresponding adapter and an optional default model. Ensures that each provider is unique and sets the default selection if not already set.
    register(provider: string, adapter: Adapter, { defaultModel }: { defaultModel?: string } = {}) {
        if (this.#providers.has(provider)) {
            throw new Error(`duplicate LLM provider: ${provider}`)
        }

        this.#providers.set(provider, adapter)

        if (!this.#defaultSelection) {
            const model = defaultModel ?? adapter.models?.[0]
            if (model) this.#defaultSelection = `${provider}/${model}`
        }// If no default selection is set, use the provided default model or the first model from the adapter as the default selection

        let disposed = false
        return () => {
            if (disposed) return
            disposed = true
            if (this.#providers.get(provider) === adapter) {
                this.#providers.delete(provider)
            }
        }
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

    // Check if a given model selection is available in the registered providers. The selection can be a string in the format "provider/model" or an object with provider and model properties.
    has(selection: ModelSelection) {
        const { provider, model } = normalizeSelection(selection)
        const adapter = this.#providers.get(provider)
        if (!adapter) return false
        if (!adapter.models?.length) return true
        return adapter.models.includes(model)
    }

    // Perform a chat operation using the specified model selection. It normalizes the selection, retrieves the appropriate adapter, and invokes the chat method on the adapter with the provided request and model.
    async chat(request: ChatRequest, selection: ModelSelection = this.#defaultSelection) {
        const { provider, model } = normalizeSelection(selection)
        const adapter = this.#providers.get(provider)

        if (!adapter) {
            throw new Error(`no LLM provider: ${provider}`)
        }

        return adapter.chat({ ...request, model })
    }
}

// Normalize the model selection input to ensure it has both provider and model properties. Throws errors for invalid formats or missing information.
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