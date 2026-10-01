import { Context } from '@deepseek-ai/cordis'
import type { Fixture, FixtureAdapter } from './eval-fixture.js'
import { CLI_BUDGET } from '../src/core/budget.js'
import type { BudgetPolicy } from '../src/core/budget.js'
import { assertToolProtocol } from '../src/core/context-runtime.js'
import { JsonlStore } from '../src/core/event-store.js'
import type { Agent, ChatRequest, ChatResponse, ToolCall } from '../src/core/contracts.js'
import * as sessions from '../src/plugins/session.js'
import * as systemPrompt from '../src/plugins/system-prompt.js'
import * as tools from '../src/plugins/tools.js'
import * as llm from '../src/plugins/llm.js'
import * as agents from '../src/plugins/agent.js'
import * as agentLoop from '../src/plugins/agent-loop.js'
import * as runtimeContext from '../src/plugins/runtime-context.js'
import * as projectContext from '../src/plugins/project-context.js'
import * as sandbox from '../src/plugins/sandbox.js'
import * as files from '../src/tools/files.js'
import * as bash from '../src/tools/bash.js'

// NX-10 三幕演示共用的装配与输出工具。
//
// 装配按 src/index.ts:26-37 的**生产接法**，而不是 scripts/eval-fixture.ts 的评测接法：后者（:96-101）
// 不装载 runtime-context 与 project-context，因此既没有 coding 身份、也拿不到 AGENTS.md 规则和
// project_context 工具——「项目规则 → 定位」这一段在评测路径上根本不存在，现有 14 个 fixture 的
// initial/ 里也一个规则文件都没有。
//
// 之所以不把这两个插件补进 runFixtureTask：那会改掉 eval:offline / eval:screening 与对照 A 两臂的
// 系统提示，让已记录的基线数字与预注册上限不再对应同一件事。演示自带装配，评测路径一字不动。
export interface DemoHarness {
  root: Context
  sessionId: string
  agent: Agent
  store?: JsonlStore
  // 先等写入队列排空再关存储（否则最后几条证据不落盘），然后释放插件，最后清理临时工作区。
  dispose(): Promise<void>
}
export interface DemoOptions {
  budget?: Readonly<BudgetPolicy>
  sessionDirectory?: string
  // 第三幕只关心事件日志，用 false 跳过两个 context 插件，让因果链停在「工具已写、结果未落盘」上。
  projectRules?: boolean
}

export async function assembleDemoHarness(fixture: Fixture, makeAdapter: (fixture: Fixture) => FixtureAdapter, options: DemoOptions = {}): Promise<DemoHarness> {
  const root = new Context()
  let store: JsonlStore | undefined
  try {
    for (const plugin of [sessions, systemPrompt, tools, llm, agents, agentLoop]) await root.plugin(plugin)
    await root.plugin(runtimeContext, { workspace: fixture.workspace, profile: 'coding' })
    await root.plugin(sandbox, { workspace: fixture.workspace, autoApprove: true })
    if (options.projectRules !== false) await root.plugin(projectContext)
    await root.plugin(files); await root.plugin(bash)
    const adapter = makeAdapter(fixture)
    root.llm.register(adapter.provider, { models: [adapter.model], ...(adapter.capabilities ? { capabilities: adapter.capabilities } : {}), chat: adapter.chat })
    // workspace 进 meta 是必须的：SessionRuntime.restore 会拿它做校验（session-runtime.ts:43），
    // 缺了就恢复不到同一个工作区。
    const session = root.sessions.create({ source: 'demo', workspace: fixture.workspace })
    if (options.sessionDirectory) {
      store = await JsonlStore.open(options.sessionDirectory, session.id)
      root.sessions.attachStore(session.id, store)
    }
    const agent = root.agents.create({ name: 'demo-agent', sessionId: session.id, model: `${adapter.provider}/${adapter.model}`, loop: root.agentLoop, budget: options.budget ?? CLI_BUDGET })
    return {
      root, sessionId: session.id, agent, store,
      async dispose() {
        if (store) await root.sessions.close()
        await root.fiber.dispose()
        await fixture.close()
      },
    }
  } catch (error) {
    await store?.close()
    await root.fiber.dispose()
    await fixture.close()
    throw error
  }
}

// 预设工具序列驱动的模拟模型：与 eval-fixture.ts 的 scriptedAdapter 同类，差别只在命令表由调用方给出。
// 所以「固定代码修复演示」是逐字可复现的，也不产生任何付费调用。
// capabilities 必须随适配器一起声明：投影只在能查到窗口容量时才拿得到 contextWindowTokens，否则预算
// 校验会以「缺少上下文容量」直接失败，而不是静默退化成无上限。键名要和 model 一致（llm-runtime.ts:33）。
export function scriptedSteps(steps: readonly { call: ToolCall }[]): () => FixtureAdapter {
  return () => {
    let step = 0
    return {
      provider: 'scripted', model: 'demo', capabilities: { demo: { contextWindowTokens: 1_000_000 } },
      chat: async ({ messages = [] }: ChatRequest): Promise<ChatResponse> => {
        assertToolProtocol(messages)
        return step < steps.length ? { toolCalls: [steps[step++].call] } : { content: '脚本化模型：预设序列执行完毕' }
      },
    }
  }
}

export function heading(text: string) { console.log(`\n=== ${text} ===`) }

// 工具结果一律按模型当时看到的原文打印，不做改写：演示要让人核对的是 Harness 真的产出了什么。
// 截断只用于兜底异常大的输出，且截断本身会写出来，不静默丢内容。
export function excerpt(text: string, limit = 3000) {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…（已截断到 ${limit} 字符，完整内容见事件日志）`
}
