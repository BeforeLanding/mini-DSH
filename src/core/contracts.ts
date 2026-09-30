import type { BudgetPolicy, RunState, Usage } from './budget.js'
import type { FileSnapshot } from './file-edit.js'
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
  maxOutputTokens?: number
  system?: string; messages?: Message[]; tools?: ToolSchema[]; model?: string
  signal?: AbortSignal; onReasoning?: (chunk: string) => void; onContent?: (chunk: string) => void
}
export interface ChatResponse { usage?: Usage; finishReason?: string; complete?: boolean; content?: string; reasoningContent?: string; toolCalls?: ToolCall[] }
export interface Adapter { capabilities?: Record<string, { contextWindowTokens: number }>; models?: string[]; chat(request: ChatRequest): Promise<ChatResponse> }
//standardized interface for LLM adapters. The Adapter interface defines the capabilities, available models, and a chat method.

export interface RunOptions {
  budget?: BudgetPolicy
  signal?: AbortSignal; onReasoning?: (chunk: string) => void; onContent?: (chunk: string) => void
  onToolCall?: (call: ToolCall) => void
  onToolResult?: (result: ToolResult & { renderedContent: string; name: string; toolCallId: string }) => void
}

export interface Agent {
  id: string; name: string; sessionId: string; model: ModelSelection; budget?: BudgetPolicy
  send(input: string, options?: RunOptions): Promise<string>
  continue(options?: RunOptions): Promise<string>
}
export interface Loop { run(agent: Agent, input: string | undefined, options?: RunOptions): Promise<string> }

export interface Execution { approval?: <T>(work: () => Promise<T>) => Promise<T>; signal: AbortSignal; sessionId?: string; toolCallId?: string; agent?: Agent }
export interface ContentBlock { type: string; text?: string; [key: string]: unknown }
export interface ToolResult { value: unknown; content: ContentBlock[]; isError: boolean }
export interface ToolDefinition {
  name: string; description?: string; parameters?: Arguments
  execute(args: Arguments, execution: Execution): unknown | Promise<unknown>
  output?: { render(args: Arguments, value: unknown): ContentBlock[]; isError?(value: unknown): boolean }
  finalizeContent?(execution: Execution, result: ToolResult): ContentBlock[] | undefined | Promise<ContentBlock[] | undefined>
}
export interface PromptContext { agent?: Agent; sessionId?: string; step?: number }
export interface PromptEntry { name: string; order?: number; text: string | ((context: PromptContext) => string | Promise<string>) }
export interface ApprovalRequest { tool: string; summary: string; signal?: AbortSignal; approval?: <T>(work: () => Promise<T>) => Promise<T> }
export interface SandboxConfig { workspace?: string; autoApprove?: boolean; allowHosts?: string[] }
export interface EventData {
  'verification/start': import('./task-verification.js').VerificationStart
  'verification/result': import('./task-verification.js').VerificationResult
  'file/baseline': { path: string; snapshot: FileSnapshot }
  'file/observed': { path: string; hash: string }
  'file/change': { changeId: string; path: string; tool: 'edit_file' | 'write_file'; toolCallId?: string; before?: FileSnapshot; after?: FileSnapshot }
  'file/change-result': { changeId: string; status: 'applied' | 'unchanged' | 'failed'; error?: string }
  'session/start': { meta: Arguments; reset?: boolean }
  'session/config': { model: string; budget: BudgetPolicy }
  'session/reset': { epoch: number }
  'run/start': { state: RunState }
  'run/finish': { state: RunState }
  'model/start': { taskId: string; runId: string; requestId: string; estimatedInputTokens?: number }
  // requestId 可缺省以兼容旧日志；存在时它与随后的 model/start 相同，使投影归属成为日志中可读的事实，
  // 而不是依赖“同一 run 内最近一个投影”的位置推断。投影已发出但对应 model/start 缺失，即该请求因
  // 上下文溢出或 token 预算未发出。
  'context/projection': { requestId?: string; estimatedInputTokens: number; reservedOutputTokens: number; safetyMarginTokens: number; removedTaskIds: string[] }
  'model/fragment': { requestId: string; content: string; reasoningContent: string }
  'model/end': { requestId: string; complete: boolean; finishReason?: string }
  'model/usage': { taskId: string; runId: string; requestId: string; usage: Usage }
  'tool/start': { taskId: string; runId: string; toolCallId: string; name: string }
  'user/message': { content: string }
  'assistant/message': { content: string; reasoningContent?: string }
  'assistant/tool_calls': { content?: string | null; reasoningContent?: string; toolCalls: ToolCall[] }
  'tool/result': { toolCallId: string; name?: string; isError?: boolean; status?: 'completed' | 'skipped' | 'unknown'; content: string }
}
export type SessionEvent = { [K in keyof EventData]: { version: 1; sessionId: string; id: string; taskId?: string; runId?: string; seq: number; type: K; data: EventData[K]; at: string } }[keyof EventData]
export interface Session { id: string; meta: Arguments; events: SessionEvent[]; createdAt: string }
