import type { AgentRuntime } from '../core/agent-runtime.js'
import type { AgentLoopRuntime } from '../core/agent-loop-runtime.js'
import type { LlmRuntime } from '../core/llm-runtime.js'
import type { SessionRuntime } from '../core/session-runtime.js'
import type { SystemPromptRuntime } from '../core/system-prompt-runtime.js'
import type { ToolRuntime } from '../core/tool-runtime.js'
import type { SandboxRuntime } from '../core/sandbox-runtime.js'
declare module '@deepseek-ai/cordis' {
  interface Context {
    agents: Pick<AgentRuntime, keyof AgentRuntime>
    agentLoop: Pick<AgentLoopRuntime, 'run'>
    llm: Pick<LlmRuntime, keyof LlmRuntime>
    sessions: Pick<SessionRuntime, keyof SessionRuntime>
    systemPrompt: Pick<SystemPromptRuntime, keyof SystemPromptRuntime>
    tools: Pick<ToolRuntime, keyof ToolRuntime>
    sandbox: Pick<SandboxRuntime, keyof SandboxRuntime>
  }
}
