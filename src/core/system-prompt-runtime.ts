import type { PromptEntry, PromptContext } from './contracts.js'
// 前缀缓存安全：一次请求的缓存键是它的**前缀**，服务端只复用与上次逐字节相同的那一段，第一处不同之后
// 全部作废。系统提示排在最前面，所以它只要有一处每轮都变，从那一处起连同整段对话历史每轮都要重算——
// 命中量塌到「易变段落之前的那一小截」。
// stableText 是兜底做法：把一次渲染的结果定住，此后每轮返回同一串字节。要保留新鲜度的易变内容，正确的
// 做法是把它作为消息下发，而不是留在系统提示里。
// 由插件在各自的 apply 里构造，寿命因此正好是该 Context（评测里一次 run、CLI 里一个进程），跨会话不串味。
// 渲染抛错时不缓存：下一轮重试，而不是把一个会话永久钉在失败状态上。
export function stableText(render: () => string | Promise<string>): () => Promise<string> {
    let cached: string | undefined
    return async () => (cached ??= await render())
}
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
