import { AgentLoopRuntime } from '../src/core/agent-loop-runtime.js'
import { AgentRuntime } from '../src/core/agent-runtime.js'
import { LlmRuntime } from '../src/core/llm-runtime.js'
import { SessionRuntime } from '../src/core/session-runtime.js'
import { SystemPromptRuntime } from '../src/core/system-prompt-runtime.js'
import { ToolRuntime } from '../src/core/tool-runtime.js'
import type { Adapter } from '../src/core/contracts.js'
export function harness(chat: Adapter['chat']) {
  const sessions = new SessionRuntime(), tools = new ToolRuntime(), llm = new LlmRuntime()
  llm.register('mock', { models: ['test'], chat })
  const loop = new AgentLoopRuntime({ sessions, tools, llm, systemPrompt: new SystemPromptRuntime() })
  const session = sessions.create()
  const agent = new AgentRuntime().create({ sessionId: session.id, model: 'mock/test', loop })
  return { sessions, tools, llm, loop, session, agent }
}
