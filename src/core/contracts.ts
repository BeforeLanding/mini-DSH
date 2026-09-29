import type { BudgetPolicy } from './budget.js'
export type Arguments = Record<string, unknown>
export type ModelSelection = string | { provider: string; model: string } | null
export interface ToolCall { id: string; name: string; arguments?: Arguments }
export interface Message {
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: string | null
  reasoning_content?: string
  tool_call_id?: string
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
}
export interface ToolSchema { type: 'function'; function: { name: string; description: string; parameters: Arguments } }
export interface ChatRequest {
  system?: string; messages?: Message[]; tools?: ToolSchema[]; model?: string
  signal?: AbortSignal; onReasoning?: (chunk: string) => void; onContent?: (chunk: string) => void
}
export interface ChatResponse { content?: string; reasoningContent?: string; toolCalls?: ToolCall[] }
export interface Adapter { models?: string[]; chat(request: ChatRequest): Promise<ChatResponse> }
export interface RunOptions {
  budget?: BudgetPolicy
  signal?: AbortSignal; onReasoning?: (chunk: string) => void; onContent?: (chunk: string) => void
  onToolCall?: (call: ToolCall) => void
  onToolResult?: (result: ToolResult & { renderedContent: string; name: string; toolCallId: string }) => void
}
export interface Agent {
  id: string; name: string; sessionId: string; model: ModelSelection; budget?: BudgetPolicy
  send(input: string, options?: RunOptions): Promise<string>
}
export interface Loop { run(agent: Agent, input: string, options?: RunOptions): Promise<string> }
export interface Execution { signal: AbortSignal; sessionId?: string; toolCallId?: string; agent?: Agent }
export interface ContentBlock { type: string; text?: string; [key: string]: unknown }
export interface ToolResult { value: unknown; content: ContentBlock[]; isError: boolean }
export interface ToolDefinition {
  name: string; description?: string; parameters?: Arguments
  execute(args: Arguments, execution: Execution): unknown | Promise<unknown>
  output?: { render(args: Arguments, value: unknown): ContentBlock[] }
  finalizeContent?(execution: Execution, result: ToolResult): ContentBlock[] | undefined | Promise<ContentBlock[] | undefined>
}
export interface PromptContext { agent?: Agent; sessionId?: string; step?: number }
export interface PromptEntry { name: string; order?: number; text: string | ((context: PromptContext) => string | Promise<string>) }
export interface ApprovalRequest { tool: string; summary: string; signal?: AbortSignal }
export interface SandboxConfig { workspace?: string; autoApprove?: boolean; allowHosts?: string[] }
export interface EventData {
  'session/start': { meta: Arguments; reset?: boolean }
  'user/message': { content: string }
  'assistant/message': { content: string; reasoningContent?: string }
  'assistant/tool_calls': { content?: string | null; reasoningContent?: string; toolCalls: ToolCall[] }
  'tool/result': { toolCallId: string; name?: string; isError?: boolean; content: string }
}
export type SessionEvent = { [K in keyof EventData]: { seq: number; type: K; data: EventData[K]; at: string } }[keyof EventData]
export interface Session { id: string; meta: Arguments; events: SessionEvent[]; createdAt: string }
