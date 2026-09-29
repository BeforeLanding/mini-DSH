import type { Context } from '@deepseek-ai/cordis'
import type { Adapter, Arguments, ChatRequest } from '../core/contracts.js'
interface WireCall { id: string; name: string; arguments: string }
interface Delta { index?: number; id?: string; function?: { name?: string; arguments?: string } }
interface StreamEvent { error?: { message?: string }; choices?: { delta?: { content?: string; reasoning_content?: string; tool_calls?: Delta[] } }[] }
// DeepSeek LLM provider for mini-DSH, which handles streaming responses and tool calls.

export const name = 'mini-model-deepseek'
export const inject = ['llm']

// The apply function registers the DeepSeek LLM provider with the mini-DSH context, allowing it to be used for chat operations. It requires an API key and optionally accepts a base URL, a list of models, and a default model selection.
export async function* parseSSE(response: { body: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; releaseLock(): void } } | null }): AsyncGenerator<StreamEvent> {
  if (!response.body) throw new Error('DeepSeek API returned no response body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const parse = (line: string): StreamEvent | null | undefined => {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) return undefined
    const data = trimmed.slice(5).trim()
    if (data === '[DONE]') return null
    return data ? JSON.parse(data) : undefined
  }
  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      if (done && buffer) { lines.push(buffer); buffer = '' }
      for (const line of lines) {
        const event = parse(line)
        if (event === null) return
        if (event !== undefined) yield event
      }
      if (done) return
    }
  } finally { reader.releaseLock() }
}

// Accumulate tool call deltas from the streaming response, allowing for the reconstruction of complete tool calls from partial updates.
export function accumulateToolCallDelta(map: Map<number, WireCall>, delta: Delta) {
  const index = delta.index ?? 0
  const call = map.get(index) ?? { id: '', name: '', arguments: '' }
  if (delta.id) call.id += delta.id
  call.name += delta.function?.name ?? ''
  call.arguments += delta.function?.arguments ?? ''
  map.set(index, call)
}

// Parse tool arguments from a JSON string, throwing an error if the JSON is incomplete or invalid.
export function parseToolArguments(text: string): Arguments {
  if (!text?.trim()) return {}
  try { return JSON.parse(text) } catch (error) {
    throw new Error('incomplete tool arguments JSON', { cause: error })
  }
}

// Finalize tool calls by sorting them and ensuring they have valid names and parsed arguments, preparing them for execution.
export function finalizeToolCalls(map: Map<number, WireCall>) {
  return [...map.entries()].sort(([a], [b]) => a - b)
    .filter(([, call]) => call.name)
    .map(([index, call]) => ({ id: call.id || `call_${index}`, name: call.name, arguments: parseToolArguments(call.arguments) }))
}

export function apply(ctx: Context, config: { apiKey?: string; baseUrl?: string; models?: string[]; defaultModel?: string; thinking?: string } = {}) {
  const apiKey = config.apiKey ?? process.env.DEEPSEEK_API_KEY
  if (!apiKey) throw new Error('missing DEEPSEEK_API_KEY; copy .env.example to .env and fill it in')
  const baseUrl = (config.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, '')
  const models = config.models ?? ['deepseek-v4-pro', 'deepseek-v4-flash']
  const adapter: Adapter = {
    models,
    async chat({ system, messages = [], tools = [], model, signal, onReasoning, onContent }: ChatRequest) {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, signal,
        body: JSON.stringify({
          model, stream: true,
          thinking: { type: config.thinking ?? process.env.DEEPSEEK_THINKING ?? 'enabled' },
          messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages],
          ...(tools.length ? { tools } : {}),
        }),
      })
      if (!response.ok) throw new Error(`DeepSeek API ${response.status}: ${await response.text()}`)
      let content = ''
      let reasoningContent = ''
      const calls = new Map<number, WireCall>()
      for await (const event of parseSSE(response)) {
        if (event.error) throw new Error(event.error.message ?? 'DeepSeek stream error')
        const delta = event.choices?.[0]?.delta
        if (!delta) continue
        if (delta.reasoning_content) { reasoningContent += delta.reasoning_content; onReasoning?.(delta.reasoning_content) }
        if (delta.content) { content += delta.content; onContent?.(delta.content) }
        for (const call of delta.tool_calls ?? []) accumulateToolCallDelta(calls, call)
      }
      return { content, reasoningContent, toolCalls: finalizeToolCalls(calls) }
    },
  }
  ctx.effect(() => ctx.llm.register('deepseek', adapter, { defaultModel: config.defaultModel ?? models[0] }), 'register deepseek provider')
}
