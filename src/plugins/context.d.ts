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
    agentLoop: Pick<AgentLoopRuntime, 'run' | 'compact'>
    llm: Pick<LlmRuntime, keyof LlmRuntime>
    sessions: Pick<SessionRuntime, keyof SessionRuntime>
    systemPrompt: Pick<SystemPromptRuntime, keyof SystemPromptRuntime>
    tools: Pick<ToolRuntime, keyof ToolRuntime>
    sandbox: Pick<SandboxRuntime, keyof SandboxRuntime>
  }
}

/*
 * Type declaration file for the Context interface in the @deepseek-ai/cordis module. 
it extends the Context interface to include properties for agents, agentLoop, llm, sessions, systemPrompt, tools, and sandbox, 
each of which is a subset of their respective runtime interfaces. this allows for better type checking and autocompletion when using the Context object in the codebase.
*/