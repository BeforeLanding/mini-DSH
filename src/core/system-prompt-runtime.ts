import type { PromptEntry, PromptContext } from './contracts.js'
export class SystemPromptRuntime {
    #sections = new Map<string, PromptEntry>()
    #contexts = new Map<string, PromptEntry>()

    section(section: PromptEntry) {
        return this.#register(this.#sections, section, 'section')
    }

    context(context: PromptEntry) {
        return this.#register(this.#contexts, context, 'context')
    }

    #register(store: Map<string, PromptEntry>, item: PromptEntry, kind: string) {
        if (!item?.name) throw new Error(`${kind}.name is required`)
        if (store.has(item.name)) throw new Error(`duplicate ${kind}: ${item.name}`)

        const normalized = {
            order: 0,
            ...item,
        }
        store.set(item.name, normalized)

        let disposed = false
        return () => {
            if (disposed) return
            disposed = true
            if (store.get(item.name) === normalized) store.delete(item.name)
        }
    }

    async assemble(assembleContext: PromptContext = {}) {
        const entries = [...this.#sections.values(), ...this.#contexts.values()].sort(
            (a, b) => (a.order ?? 0) - (b.order ?? 0),
        )

        const parts = []
        for (const item of entries) {
            const text =
                typeof item.text === 'function' ? await item.text(assembleContext) : item.text
            if (text?.trim()) parts.push(text.trim())
        }
        return parts.join('\n\n')
    }

    inspect() {
        return {
            sections: [...this.#sections.values()].map(({ name, order }) => ({ name, order })),
            contexts: [...this.#contexts.values()].map(({ name, order }) => ({ name, order })),
        }
    }
}
