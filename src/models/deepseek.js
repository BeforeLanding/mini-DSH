export const name = 'mini-model-deepseek'
export const inject = ['llm']

export async function* parseSSE(response) {
  if (!response.body) throw new Error('DeepSeek API returned no response body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const parse = line => {
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
      buffer = lines.pop()
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

export function accumulateToolCallDelta(map, delta) {
  const index = delta.index ?? 0
  const call = map.get(index) ?? { id: '', name: '', arguments: '' }
  if (delta.id) call.id += delta.id
  call.name += delta.function?.name ?? ''
  call.arguments += delta.function?.arguments ?? ''
  map.set(index, call)
}

export function parseToolArguments(text) {
  if (!text?.trim()) return {}
  try { return JSON.parse(text) } catch (error) {
    throw new Error('incomplete tool arguments JSON', { cause: error })
  }
}

export function finalizeToolCalls(map) {
  return [...map.entries()].sort(([a], [b]) => a - b)
    .filter(([, call]) => call.name)
    .map(([index, call]) => ({ id: call.id || `call_${index}`, name: call.name, arguments: parseToolArguments(call.arguments) }))
}

export function apply(ctx, config = {}) {
  const apiKey = config.apiKey ?? process.env.DEEPSEEK_API_KEY
  if (!apiKey) throw new Error('missing DEEPSEEK_API_KEY; copy .env.example to .env and fill it in')
  const baseUrl = (config.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, '')
  const models = config.models ?? ['deepseek-v4-pro', 'deepseek-v4-flash']
  const adapter = {
    models,
    async chat({ system, messages = [], tools = [], model, signal, onReasoning, onContent }) {
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
      const calls = new Map()
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
