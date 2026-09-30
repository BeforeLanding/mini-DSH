import { Context } from '@deepseek-ai/cordis'
import { createFixture } from './coding-fixtures.js'
import type { FixtureId } from './coding-fixtures.js'
import { singleRunBudget } from './eval-runner.js'
import type { RunOutcome } from './eval-runner.js'
import { BudgetStop } from '../src/core/budget.js'
import type { BudgetPolicy } from '../src/core/budget.js'
import { assertToolProtocol } from '../src/core/context-runtime.js'
import type { Adapter, ChatRequest, ChatResponse, ToolCall } from '../src/core/contracts.js'
import * as sessions from '../src/plugins/session.js'
import * as systemPrompt from '../src/plugins/system-prompt.js'
import * as tools from '../src/plugins/tools.js'
import * as llm from '../src/plugins/llm.js'
import * as agents from '../src/plugins/agent.js'
import * as agentLoop from '../src/plugins/agent-loop.js'
import * as sandbox from '../src/plugins/sandbox.js'
import * as files from '../src/tools/files.js'
import * as bash from '../src/tools/bash.js'

export type Fixture = Awaited<ReturnType<typeof createFixture>>
export interface FixtureAdapter { provider: string; model: string; chat: Adapter['chat'] }

// 适配器在 fixture 建好之后才构造：模拟模型需要读取该 fixture 的参考改动来生成工具序列。
// 真实适配器忽略入参即可，运行器因此不感知模型来源。
export async function runFixtureTask(
  id: FixtureId, makeAdapter: (fixture: Fixture) => FixtureAdapter, budget: Readonly<BudgetPolicy> = singleRunBudget,
): Promise<RunOutcome> {
  const fixture = await createFixture(id), root = new Context()
  try {
    for (const plugin of [sessions, systemPrompt, tools, llm, agents, agentLoop]) await root.plugin(plugin)
    await root.plugin(sandbox, { workspace: fixture.workspace, autoApprove: true })
    await root.plugin(files); await root.plugin(bash)
    const adapter = makeAdapter(fixture)
    root.llm.register(adapter.provider, { models: [adapter.model], chat: adapter.chat })
    const session = root.sessions.create({ source: 'eval', fixtureId: id })
    const agent = root.agents.create({ sessionId: session.id, model: `${adapter.provider}/${adapter.model}`, loop: root.agentLoop, budget })
    let error: string | undefined
    try {
      await agent.send(fixture.task)
    } catch (cause) {
      // 预算触顶是 run 的停止原因，由状态承载；只有基础设施失败才记作 error。
      if (!(cause instanceof BudgetStop)) error = cause instanceof Error ? cause.message : String(cause)
    }
    const state = root.sessions.latestRun(session.id)!
    const acceptance = await fixture.evaluate()
    return { status: state.status, counters: state.counters, accepted: acceptance.passed, ...(error === undefined ? {} : { error }) }
  } finally {
    await root.fiber.dispose()
    await fixture.close()
  }
}

// 预设工具序列驱动的模拟模型：验证运行器与 Harness 接线，不作为自主编程成功率证据（见 PLAN NX-05a）。
export function scriptedAdapter(fixture: Fixture): FixtureAdapter {
  const commands: ToolCall[] = fixture.edits.map((edit, index) => ({ id: `read-${index}`, name: 'read_file', arguments: { path: edit.path } }))
  commands.push({ id: 'before', name: 'bash', arguments: { command: 'node check.mjs' } })
  for (const [index, edit] of fixture.edits.entries()) commands.push({ id: `edit-${index}`, name: 'edit_file', arguments: edit })
  commands.push({ id: 'after', name: 'bash', arguments: { command: 'node check.mjs' } })
  let step = 0
  return {
    provider: 'scripted', model: 'fixture',
    chat: async ({ messages = [] }: ChatRequest): Promise<ChatResponse> => {
      assertToolProtocol(messages)
      return step < commands.length ? { toolCalls: [commands[step++]] } : { content: 'scripted run finished' }
    },
  }
}
