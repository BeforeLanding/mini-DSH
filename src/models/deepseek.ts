import type { Usage } from '../core/budget.js'
import { isRecord } from '../core/event-store.js'
import { ModelStreamError } from '../core/model-error.js'
import type { Context } from '@deepseek-ai/cordis'
import type { Adapter, Arguments, ChatRequest } from '../core/contracts.js'
interface WireCall { id: string; name: string; arguments: string }
interface Delta { index?: number; id?: string; function?: { name?: string; arguments?: string } }
interface StreamEvent { usage?: unknown; error?: { message?: string }; choices?: { finish_reason?: string; delta?: { content?: string; reasoning_content?: string; tool_calls?: Delta[] } }[] }
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
    if (!data) return undefined
    const event: unknown = JSON.parse(data)
    if (!isRecord(event) || (event.choices !== undefined && !Array.isArray(event.choices))) throw new Error('invalid SSE event')
    return event as StreamEvent
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
  try {
    const value: unknown = JSON.parse(text)
    if (!isRecord(value)) throw new Error('tool arguments must be an object')
    return value
  } catch (error) {
    throw new Error('incomplete tool arguments JSON', { cause: error })
  }
}

// Finalize tool calls by sorting them and ensuring they have valid names and parsed arguments, preparing them for execution.
export function finalizeToolCalls(map: Map<number, WireCall>) {
  return [...map.entries()].sort(([a], [b]) => a - b)
    .filter(([, call]) => call.name)
    .map(([index, call]) => ({ id: call.id || `call_${index}`, name: call.name, arguments: parseToolArguments(call.arguments) }))
}

export interface DeepSeekConfig { apiKey?: string; baseUrl?: string; models?: string[]; defaultModel?: string; thinking?: string; contextWindowTokens?: number; fetch?: typeof fetch }
export function normalizeUsage(raw: unknown): Usage | undefined {
  if (raw == null) return undefined
  if (!isRecord(raw)) throw new Error('invalid model usage')
  const input = raw.prompt_tokens, output = raw.completion_tokens
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0 || typeof output !== 'number' || !Number.isSafeInteger(output) || output < 0 || raw.total_tokens !== input + output) throw new Error('invalid model usage counts')
  const reasoning = isRecord(raw.completion_tokens_details) ? raw.completion_tokens_details.reasoning_tokens : undefined
  if (reasoning !== undefined && (typeof reasoning !== 'number' || !Number.isSafeInteger(reasoning) || reasoning < 0 || reasoning > output)) throw new Error('invalid reasoning usage')
  return { inputTokens: input, outputTokens: output, totalTokens: input + output, source: 'provider', uncertain: false, ...(typeof reasoning === 'number' ? { reasoningTokens: reasoning } : {}) }
}
export function createDeepSeekAdapter(config: DeepSeekConfig = {}): Adapter {
  const apiKey = config.apiKey ?? process.env.DEEPSEEK_API_KEY
  if (!apiKey) throw new Error('missing DEEPSEEK_API_KEY; copy .env.example to .env and fill it in')
  const baseUrl = (config.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, '')
  const models = config.models ?? ['deepseek-v4-pro', 'deepseek-v4-flash']
  const configuredCapacity = config.contextWindowTokens ?? (baseUrl === 'https://api.deepseek.com' && !config.models ? 1_000_000 : undefined)
  const adapter: Adapter = {
    models,
    capabilities: configuredCapacity === undefined ? undefined : Object.fromEntries(models.map(model => [model, { contextWindowTokens: configuredCapacity }])),
    async chat({ system, messages = [], tools = [], model, signal, onReasoning, onContent, maxOutputTokens }: ChatRequest) {
      const response = await (config.fetch ?? fetch)(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, signal,
        body: JSON.stringify({
          model, stream: true, stream_options: { include_usage: true },
          ...(maxOutputTokens !== undefined ? { max_tokens: maxOutputTokens } : {}),
          thinking: { type: config.thinking ?? process.env.DEEPSEEK_THINKING ?? 'enabled' },
          messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages],
          ...(tools.length ? { tools } : {}),
        }),
      })
      if (!response.ok) throw new Error(`DeepSeek API ${response.status}: ${await response.text()}`)
      let content = ''
      let reasoningContent = ''
      const calls = new Map<number, WireCall>()
      let usage: Usage | undefined
      let finishReason: string | undefined
      try {
      for await (const event of parseSSE(response)) {
        if (event.error) throw new Error(event.error.message ?? 'DeepSeek stream error')
        if (event.usage != null) usage = normalizeUsage(event.usage)
        finishReason = event.choices?.[0]?.finish_reason ?? finishReason
        const delta = event.choices?.[0]?.delta
        if (!delta) continue
        if (delta.reasoning_content) { reasoningContent += delta.reasoning_content; onReasoning?.(delta.reasoning_content) }
        if (delta.content) { content += delta.content; onContent?.(delta.content) }
        for (const call of delta.tool_calls ?? []) accumulateToolCallDelta(calls, call)
      }
      const complete = finishReason === 'stop' || finishReason === 'tool_calls'
      return { content, reasoningContent, usage, finishReason, complete, toolCalls: complete ? finalizeToolCalls(calls) : [] }
      } catch (error) { throw new ModelStreamError(error instanceof Error ? error.message : String(error), { content, reasoningContent, usage, finishReason, complete: false }, error) }
    },
  }
  return adapter
}
export function apply(ctx: Context, config: DeepSeekConfig = {}) {
  const adapter = createDeepSeekAdapter(config)
  ctx.effect(() => ctx.llm.register('deepseek', adapter, { defaultModel: config.defaultModel ?? adapter.models?.[0] }), 'register deepseek provider')
}
