import type { ChatRequest, ChatResponse } from './contracts.js'
import type { Usage } from './budget.js'
/** Engineering approximation: ASCII 0.3, other Unicode codepoints 1.0. */
export function estimateText(text: string): number {
  let tenths = 0
  for (const char of text) tenths += char.codePointAt(0)! <= 0x7f ? 3 : 10
  return Math.ceil(tenths / 10)
}
export function estimateInput(request: ChatRequest): number {
  const messages = request.messages ?? []
  return 256 + 32 * (messages.length + (request.system ? 1 : 0)) + estimateText(JSON.stringify({ system: request.system ?? '', messages, tools: request.tools ?? [] }))
}
export function estimateUsage(inputTokens: number, response: ChatResponse = {}): Usage {
  const outputTokens = estimateText(JSON.stringify({ content: response.content ?? '', reasoningContent: response.reasoningContent ?? '', toolCalls: response.toolCalls ?? [] }))
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, source: 'estimated', uncertain: true }
}
