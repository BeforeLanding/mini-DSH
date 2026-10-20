import type { BudgetPolicy, RunState, Usage } from './budget.js'
import type { FileSnapshot } from './file-edit.js'
import type { ProviderErrorKind } from './model-error.js'
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
  purpose?: 'main' | 'summary'
  maxOutputTokens?: number
  system?: string; messages?: Message[]; tools?: ToolSchema[]; model?: string
  signal?: AbortSignal; onReasoning?: (chunk: string) => void; onContent?: (chunk: string) => void
  onProviderEvent?: (event: unknown) => void
}
export interface ChatResponse { usage?: Usage; finishReason?: string; complete?: boolean; content?: string; reasoningContent?: string; toolCalls?: ToolCall[]; observedModel?: string; systemFingerprint?: string }
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
// NX-39 新增 previewTruncated：工具结果的**预览**被截断（tool-results 插件把超限的那条截成头尾预览并落盘，
// 返回值带回 ref）。它与 `command.stdout.truncated` 是两件事——后者是命令采集本身的上限（NX-33 的尾部窗口），
// 前者是「进历史的那份被换成了预览」。对照 B 与 NX-39 因子 1 的「工具输出有界」半边量的正是后者，因此
// 字段名取 previewTruncated 而不是 truncated，避免两个截断在同一份日志里同名。
export interface ToolResult { value: unknown; content: ContentBlock[]; isError: boolean; previewTruncated?: boolean }
export interface ToolDefinition {
  name: string; description?: string; parameters?: Arguments
  exposeErrors?: boolean
  effect?: 'read' | 'write' | 'exec' | 'network' | 'unknown'
  origin?: 'builtin' | 'external'
  resources?(args: Arguments): string[]
  execute(args: Arguments, execution: Execution): unknown | Promise<unknown>
  output?: { render(args: Arguments, value: unknown): ContentBlock[]; isError?(value: unknown): boolean }
  finalizeContent?(execution: Execution, result: ToolResult): ContentBlock[] | undefined | Promise<ContentBlock[] | undefined>
}
export interface PromptContext { agent?: Agent; sessionId?: string; step?: number }
export interface PromptEntry { name: string; order?: number; text: string | ((context: PromptContext) => string | Promise<string>) }
export interface ApprovalRequest { tool: string; summary: string; signal?: AbortSignal; approval?: <T>(work: () => Promise<T>) => Promise<T> }
export interface SandboxConfig { workspace?: string; autoApprove?: boolean }
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
  'context/snapshot': { name: 'runtime:environment' | 'project:context'; text: string; source: 'new-session' | 'legacy-current' }
  'context/project-version': { digest: string; previousDigest?: string }
  'run/start': { state: RunState }
  'run/error': { errorId: string; stage: 'model' | 'summary' | 'tool' | 'runtime'; errorKind: ProviderErrorKind; safeMessage: string; requestId?: string; toolCallId?: string; httpStatus?: number; retryable?: boolean; providerRequestId?: string }
  'run/finish': { state: RunState }
  'model/start': { taskId: string; runId: string; requestId: string; estimatedInputTokens?: number }
  'model/retry': { rootRequestId: string; failedRequestId: string; nextRequestId: string; attempt: number; delayMs: number; errorKind: import('./model-error.js').ProviderErrorKind }
  'model/rejected': { requestId: string; reason: 'request_limit' | 'amount_limit' | 'usage_unknown' | 'other_limit' }
  // requestId 可缺省以兼容旧日志；存在时它与随后的 model/start 相同，使投影归属成为日志中可读的事实，
  // 而不是依赖“同一 run 内最近一个投影”的位置推断。投影已发出但对应 model/start 缺失，即该请求因
  // 上下文溢出或 token 预算未发出。
  // systemPromptDigest 是本轮装配出的系统提示的 sha256（NX-39 因子 2 的读数）。它必须记在投影里而不是
  // 由评估侧现算：付费跑留下的只有这份日志，而「第 2 轮起系统提示与前一轮逐字相同」这条预注册要求报的量
  // 除了这里没有第二个来源。**摘要而不是原文**：系统提示含工作区内容，整段入库会让证据体积随轮次膨胀，
  // 而判据只问「两轮是不是同一串」。
  'context/projection': { requestId?: string; estimatedInputTokens: number; reservedOutputTokens: number; safetyMarginTokens: number; removedTaskIds: string[]; systemPromptDigest?: string }
  'context/summary-start': { trigger: 'pressure' | 'context-overflow' | 'explicit'; budgetTokens: number; projectedTokens: number; plannedStart: number; plannedEnd: number; plannedNodes: number }
  'context/summary-end': { startSeq: number; outcome: { kind: 'applied' } | { kind: 'declined'; reason: 'summary-failed' | 'summary-empty' | 'summary-invalid' | 'summary-not-smaller' | 'turn-started' | 'plan-stale' | 'agent-gone' | 'cancelled' | 'unclosed' } }
  'context/summary': { startSeq: number; trigger: 'pressure' | 'context-overflow' | 'explicit'; budgetTokens: number; projectedTokens: number; shadowedSeqs: number[]; shadowedTokens: number; summaryTokens: number; retainedNodes: number; summary: string; frame: string }
  'model/fragment': { requestId: string; content: string; reasoningContent: string }
  'model/end': { requestId: string; complete: boolean; finishReason?: string }
  'model/usage': { taskId: string; runId: string; requestId: string; usage: Usage }
  'tool/start': { taskId: string; runId: string; toolCallId: string; name: string }
  'user/message': { content: string }
  'assistant/message': { content: string; reasoningContent?: string }
  'assistant/tool_calls': { content?: string | null; reasoningContent?: string; toolCalls: ToolCall[] }
  'tool/result': { toolCallId: string; name?: string; isError?: boolean; status?: 'completed' | 'skipped' | 'unknown'; content: string; previewTruncated?: boolean }
}
export type SessionEvent = { [K in keyof EventData]: { version: 1; sessionId: string; id: string; taskId?: string; runId?: string; seq: number; type: K; data: EventData[K]; at: string } }[keyof EventData]
export interface Session { id: string; meta: Arguments; events: SessionEvent[]; createdAt: string }
