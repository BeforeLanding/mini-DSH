import { Context } from '@deepseek-ai/cordis'
import { createFixture } from './coding-fixtures.js'
import type { FixtureId } from './coding-fixtures.js'
import { evalPolicy } from './eval-runner.js'
import type { AcceptanceDetail, RunOutcome, RunTaskDetail } from './eval-runner.js'
import { BudgetStop, emptyCounters } from '../src/core/budget.js'
import type { BudgetPolicy, Counters } from '../src/core/budget.js'
import { assertToolProtocol } from '../src/core/context-runtime.js'
import { JsonlStore } from '../src/core/event-store.js'
import type { Adapter, ChatRequest, ChatResponse, SessionEvent, ToolCall } from '../src/core/contracts.js'
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
// capabilities 必须随适配器一起传入：投影只在能查到窗口容量时才会拿到 contextWindowTokens，否则预算
// 校验会以“缺少上下文容量”直接失败，而不是静默退化成无上限。
export interface FixtureAdapter { provider: string; model: string; chat: Adapter['chat']; capabilities?: Adapter['capabilities'] }

// 各阶段 counters 求和：phaseCaps 的 requests/tokens 是整批累计量，按阶段各记一次会把同一台机器的
// 实际用量少算数倍。runs 仍按 fixture 运行次数计，不动，因此上限口径的变化需要在预注册里单独说明。
const sumCounters = (all: readonly Counters[]): Counters => all.reduce((total, counters) => ({
  modelRequests: total.modelRequests + counters.modelRequests,
  toolCalls: total.toolCalls + counters.toolCalls,
  inputTokens: total.inputTokens + counters.inputTokens,
  outputTokens: total.outputTokens + counters.outputTokens,
  totalTokens: total.totalTokens + counters.totalTokens,
  activeDurationMs: total.activeDurationMs + counters.activeDurationMs,
  approvalDurationMs: total.approvalDurationMs + counters.approvalDurationMs,
}), emptyCounters())

// 逐阶段投影观测：判断「第几个阶段开始触发裁剪」必须看该阶段自己那条 run 的投影事件，而不是 RunState。
// RunState.estimatedInputTokens 的「最近一次投影」是 D-08 的生产语义（恢复时也要按它重建），为了评测把
// 它改成“本阶段最大值”是在污染生产状态；最大值与投影次数这里现算即可。
// 也不复用 requestTrace：它按「当前 task」过滤（task-trace.ts 的 latestRun 取 taskId），同一会话里的
// 更早阶段不在它的作用域内，拿不到要的东西。
// 只读事件、不修改任何状态，因此可以直接对合成日志做构造式单测。
export function summarizeStage(events: readonly SessionEvent[], runId: string) {
  const scope = events.filter(event => event.runId === runId)
  const projections = scope.filter(event => event.type === 'context/projection')
  // 投影与 model/start 的落盘确认是异步的，两者之间存在窗口；调用点在阶段结束后，run 已 flush，
  // 该窗口不再存在，所以这里可以按 requestId 直接判定「有投影没发送」。
  const sent = new Set(scope.flatMap(event => event.type === 'model/start' ? [event.data.requestId] : []))
  const estimates: number[] = []
  const removedTaskIds: string[] = []
  let firstPrunedProjection: number | null = null
  let unsentProjections = 0
  for (const [index, event] of projections.entries()) {
    estimates.push(event.data.estimatedInputTokens)
    if (event.data.removedTaskIds.length) {
      firstPrunedProjection ??= index + 1
      for (const taskId of event.data.removedTaskIds) if (!removedTaskIds.includes(taskId)) removedTaskIds.push(taskId)
    }
    if (event.data.requestId !== undefined && !sent.has(event.data.requestId)) unsentProjections += 1
  }
  const usageSources = { provider: 0, estimated: 0 }
  for (const event of scope) if (event.type === 'model/usage') usageSources[event.data.usage.source] += 1
  return {
    ...(estimates.length ? { estimatedInputTokens: estimates.at(-1), maxEstimatedInputTokens: Math.max(...estimates) } : {}),
    projections: projections.length,
    firstPrunedProjection,
    removedTaskIds,
    unsentProjections,
    usageSources,
  }
}

// 适配器在 fixture 建好之后才构造：模拟模型需要读取该 fixture 的参考改动来生成工具序列。
// 真实适配器忽略入参即可，运行器因此不感知模型来源。
// sessionDirectory 给出时把该次 run 的事件日志落盘（每个 run 一个子目录，因 session 是随机 id），
// 让真实付费调用留下的证据不随进程退出消失；不给出时保持原有的纯内存行为，离线路径不受影响。
// fixture.tasks 的阶段按序在同一个 session 内下发：每次 send 分配新 taskId，于是先前结束的阶段成为
// 可裁剪的旧任务——这是对照 A 能产生差异的前提（单任务会话无论多大都不会触发裁剪）。验收仍在最后
// 对工作区终态做一次判定，不按阶段拆分。
export async function runFixtureTask(
  id: FixtureId, makeAdapter: (fixture: Fixture) => FixtureAdapter,
  budget: Readonly<BudgetPolicy> = evalPolicy, sessionDirectory?: string,
): Promise<RunOutcome> {
  const fixture = await createFixture(id), root = new Context()
  let store: JsonlStore | undefined
  try {
    for (const plugin of [sessions, systemPrompt, tools, llm, agents, agentLoop]) await root.plugin(plugin)
    await root.plugin(sandbox, { workspace: fixture.workspace, autoApprove: true })
    await root.plugin(files); await root.plugin(bash)
    const adapter = makeAdapter(fixture)
    root.llm.register(adapter.provider, { models: [adapter.model], ...(adapter.capabilities ? { capabilities: adapter.capabilities } : {}), chat: adapter.chat })
    const session = root.sessions.create({ source: 'eval', fixtureId: id })
    if (sessionDirectory) {
      store = await JsonlStore.open(sessionDirectory, session.id)
      root.sessions.attachStore(session.id, store)
    }
    const agent = root.agents.create({ sessionId: session.id, model: `${adapter.provider}/${adapter.model}`, loop: root.agentLoop, budget })
    let error: string | undefined
    const stages: RunTaskDetail[] = []
    for (const stage of fixture.tasks) {
      try {
        await agent.send(stage)
      } catch (cause) {
        // 预算触顶是 run 的停止原因，由状态承载；只有基础设施失败才记作 error。
        if (!(cause instanceof BudgetStop)) error = cause instanceof Error ? cause.message : String(cause)
      }
      const state = root.sessions.latestRun(session.id)
      if (state) stages.push({
        taskId: state.taskId, status: state.status, counters: state.counters,
        ...summarizeStage(root.sessions.visibleEvents(session.id), state.runId),
      })
      // 基础设施失败后不再下发下一阶段：会话或工作区已经不健康，继续跑只会把同一个失败重复记成多份，
      // 而每一份都会进入阶段累计用量。预算触顶不属于这一类，它由状态承载并继续下一阶段。
      if (error !== undefined) break
    }
    const acceptance = await fixture.evaluate()
    const detail: AcceptanceDetail = {
      passed: acceptance.passed, exitCode: acceptance.exitCode, output: acceptance.output, protectedFilesChanged: acceptance.protectedFilesChanged,
    }
    // 预算校验或装配在 beginRun 之前失败时不会留下 run 状态；此时按基础设施失败报告，不用非空断言把
    // 缺失状态伪装成一次真实的运行结论。
    const last = stages.at(-1)
    if (!last) return { status: 'error', counters: emptyCounters(), accepted: acceptance.passed, acceptance: detail, error: error ?? 'no run was recorded' }
    return { status: last.status, counters: sumCounters(stages.map(stage => stage.counters)), accepted: acceptance.passed, acceptance: detail, tasks: stages, ...(error === undefined ? {} : { error }) }
  } finally {
    // 先等写入队列排空再关存储：失败会抛出，使证据没落盘的 run 不以成功结论结束。
    if (store) await root.sessions.close()
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
    provider: 'scripted', model: 'fixture', capabilities: { fixture: { contextWindowTokens: 1_000_000 } },
    chat: async ({ messages = [] }: ChatRequest): Promise<ChatResponse> => {
      assertToolProtocol(messages)
      return step < commands.length ? { toolCalls: [commands[step++]] } : { content: 'scripted run finished' }
    },
  }
}
