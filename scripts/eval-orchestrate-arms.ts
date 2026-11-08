import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createHarness, type HarnessAdapter } from '../src/app/create-harness.js'
import { CLI_BUDGET, type BudgetPolicy, type Usage } from '../src/core/budget.js'
import type { CommandOptions, CommandResult } from '../src/core/command-runner.js'
import type { ChatRequest, ChatResponse } from '../src/core/contracts.js'
import { JsonlStore } from '../src/core/event-store.js'
import { ModelNotDispatchedError } from '../src/core/model-dispatch.js'
import { ModelStreamError } from '../src/core/model-error.js'
import { commitAll, git, stageAll } from '../src/orchestration/git.js'
import { loadOrchestration } from '../src/orchestration/inspect.js'
import { orchestrate } from '../src/orchestration/orchestrator.js'
import { batchContextWindowTokens, type BatchPrice } from './eval-orchestrate-batch.js'
import type { RunSpec } from './eval-orchestrate.js'
import {
  evaluateOrchestrationFixture, materializeOrchestrationFixture, orchestrationFixtures,
  type OrchestrationFixtureId, type VerifyResult,
} from './orchestration-fixtures.js'
import { peakUsageUsd } from './smoke-cost.js'

// 四臂执行器（TASKS M4-⑤-2）。适配器与命令 runner 都由调用方注入：`--rehearse` 注入脚本模型，
// `--execute` 注入经金额守卫包装的 DeepSeek 适配器。本模块自身不读 API key、不创建真实适配器。
export type CommandRunner = (options: CommandOptions) => Promise<CommandResult>

// ---------- 金额守卫 ----------
// 与 createSmokeAmountGuard（scripts/smoke-cost.ts）同一预留口径：每个请求按满上下文输入 + 满输出预留。
// 区别在于**在途预留**：R 的两个 worker 同时请求时，原守卫只看已结算额，两者可能合计越过上限；
// 这里把未结算请求的预留一并计入。缺 provider usage 后所有后续请求拒发，不把未知记为 0。
export type GuardStop = 'amount_limit' | 'usage_unknown'
export function createBatchAmountGuard(delegate: (request: ChatRequest) => Promise<ChatResponse>, price: BatchPrice, maxUsd: number) {
  if (!Number.isFinite(maxUsd) || maxUsd <= 0) throw new Error('batch amount guard needs a positive maxUsd')
  let spentUsd = 0, pendingUsd = 0, calls = 0, usageUnknown = false
  let stopped: GuardStop | undefined
  const chat = async (request: ChatRequest): Promise<ChatResponse> => {
    if (usageUnknown) {
      stopped ??= 'usage_unknown'
      throw new ModelNotDispatchedError('batch usage unknown; no further provider call made', 'usage_unknown')
    }
    const maxOutput = request.maxOutputTokens
    if (!Number.isSafeInteger(maxOutput) || maxOutput! <= 0) throw new ModelNotDispatchedError('batch amount guard requires an output ceiling', 'other_limit')
    const reserve = (price.peakInputPerMillion * batchContextWindowTokens + maxOutput! * price.peakOutputPerMillion) / 1_000_000
    if (spentUsd + pendingUsd + reserve > maxUsd) {
      stopped ??= 'amount_limit'
      throw new ModelNotDispatchedError('batch amount ceiling cannot reserve the next request; no provider call made', 'amount_limit')
    }
    pendingUsd += reserve
    calls++
    try {
      const response = await delegate(request)
      if (response.usage?.source !== 'provider') usageUnknown = true
      else spentUsd += peakUsageUsd(response.usage, price)
      return response
    } catch (error) {
      if (error instanceof ModelNotDispatchedError) { calls--; throw error }
      const partial = error instanceof ModelStreamError ? error.partial : undefined
      if (partial?.usage?.source === 'provider') spentUsd += peakUsageUsd(partial.usage, price)
      else usageUnknown = true
      throw error
    } finally {
      pendingUsd -= reserve
    }
  }
  return {
    chat,
    get spentUsd() { return spentUsd }, get pendingUsd() { return pendingUsd }, get calls() { return calls },
    get usageUnknown() { return usageUnknown }, get stopped() { return stopped },
  }
}

// ---------- 逐 run 计量 ----------
// 四臂共用同一个计量方式：在适配器层数请求、token、工具调用与 Bash 次数，不依赖各自的日志形状。
export interface RunMeter {
  requests: number
  failedRequests: number
  provider: { inputTokens: number; cacheReadTokens: number; outputTokens: number }
  unknownUsageResponses: number
  toolCalls: number
  bashCalls: number
  peakUsd: number
}
export function meteredAdapter(base: HarnessAdapter, price: BatchPrice) {
  const meter: RunMeter = { requests: 0, failedRequests: 0, provider: { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 }, unknownUsageResponses: 0, toolCalls: 0, bashCalls: 0, peakUsd: 0 }
  const count = (usage: Usage | undefined) => {
    if (usage?.source !== 'provider') { meter.unknownUsageResponses++; return }
    meter.provider.inputTokens += usage.inputTokens
    meter.provider.cacheReadTokens += usage.cacheReadTokens ?? 0
    meter.provider.outputTokens += usage.outputTokens
    meter.peakUsd += peakUsageUsd(usage, price)
  }
  const adapter: HarnessAdapter = {
    ...base,
    chat: async request => {
      try {
        const response = await base.chat(request)
        meter.requests++
        count(response.usage)
        for (const call of response.toolCalls ?? []) {
          meter.toolCalls++
          if (call.name === 'bash') meter.bashCalls++
        }
        return response
      } catch (error) {
        if (error instanceof ModelNotDispatchedError) throw error
        meter.requests++
        meter.failedRequests++
        count(error instanceof ModelStreamError ? error.partial?.usage : undefined)
        throw error
      }
    },
  }
  return { adapter, meter }
}

// ---------- 按工作区的命令 runner ----------
// 编排器只接受一个共享 runner，而隔离 runner 绑定单一工作区。这里按命令 cwd 向上找到所属的
// git 工作区根（含 `.git` 目录或 worktree 的 `.git` 文件），为每个根各建一个 runner 并缓存。
export function workspaceRootOf(cwd: string) {
  let current = path.resolve(cwd)
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) return current
    const parent = path.dirname(current)
    if (parent === current) throw new Error(`no git workspace contains ${cwd}`)
    current = parent
  }
}
export function perWorkspaceRunner(factory: (workspace: string) => CommandRunner): CommandRunner {
  const runners = new Map<string, CommandRunner>()
  return options => {
    const workspace = workspaceRootOf(options.cwd)
    let runner = runners.get(workspace)
    if (!runner) { runner = factory(workspace); runners.set(workspace, runner) }
    return runner(options)
  }
}

// ---------- 单个 run ----------
export interface RunContext {
  runDirectory: string
  adapter: HarnessAdapter
  price: BatchPrice
  // 未提供时 Bash 走宿主默认 runner（只用于离线单测）；批次与演练总是传入。
  commandRunnerFactory?: (workspace: string) => CommandRunner
  now?: () => number
}
export interface RunResult {
  runId: string
  taskId: string
  arm: string
  repeat: number
  status: string
  hidden: { passed: boolean; results: VerifyResult[] }
  wallMs: number
  activeMs: number
  meter: RunMeter
  orchestration?: { status: string; attempts: { subtaskId: string; status: string }[]; conflicts: number; humanRequests: number; verificationsFailed: number }
  error?: string
}

async function initialRepository(spec: RunSpec, directory: string) {
  await materializeOrchestrationFixture(spec.taskId, directory)
  await git(directory, ['init', '--quiet'])
  await git(directory, ['config', 'core.autocrlf', 'false'])
  await stageAll(directory)
  return commitAll(directory, 'initial')
}

const singleAgentBudget = (spec: RunSpec): BudgetPolicy => ({
  ...CLI_BUDGET, maxModelRequests: spec.budget.maxModelRequests, maxToolCalls: spec.budget.maxToolCalls,
  maxTotalTokens: spec.budget.maxTotalTokens, maxActiveDurationMs: spec.budget.maxWallMs, contextWindowTokens: batchContextWindowTokens,
})

async function runSingleAgent(spec: RunSpec, ctx: RunContext, repo: string, adapter: HarnessAdapter) {
  const runner = ctx.commandRunnerFactory ? perWorkspaceRunner(ctx.commandRunnerFactory) : undefined
  const harness = await createHarness({
    workspace: repo, profile: 'coding', adapter, autoApprove: true,
    ...(runner ? { commandRunner: runner } : {}),
    ...(spec.execution.delegation === 'read-only'
      ? {
          delegation: { mode: 'read-only' as const, directory: path.join(ctx.runDirectory, 'teams') },
          taskGroupPolicy: { maxModelRequests: spec.budget.maxModelRequests, maxToolCalls: spec.budget.maxToolCalls, maxTotalTokens: spec.budget.maxTotalTokens, maxWallDurationMs: spec.budget.maxWallMs },
        }
      : {}),
  })
  try {
    const session = harness.root.sessions.create({ source: 'eval-orchestrate', runId: spec.runId, workspace: repo })
    const store = await JsonlStore.open(path.join(ctx.runDirectory, 'session'), session.id)
    harness.root.sessions.attachStore(session.id, store)
    const agent = harness.root.agents.create({ sessionId: session.id, model: `${adapter.provider}/${adapter.model}`, loop: harness.root.agentLoop, budget: singleAgentBudget(spec) })
    let error: string | undefined
    try { await agent.send(spec.goal, { signal: AbortSignal.timeout(spec.budget.maxWallMs) }) } catch (cause) { error = cause instanceof Error ? cause.message : String(cause) }
    await harness.root.sessions.flush(session.id).catch(() => {})
    const status = harness.root.sessions.latestRun(session.id)?.status ?? 'unknown'
    await harness.root.sessions.close()
    return { status, ...(error ? { error } : {}) }
  } finally {
    await harness.dispose()
  }
}

async function runOrchestrated(spec: RunSpec, ctx: RunContext, repo: string, adapter: HarnessAdapter) {
  const runner = ctx.commandRunnerFactory ? perWorkspaceRunner(ctx.commandRunnerFactory) : undefined
  const result = await orchestrate({
    repository: repo, goal: spec.goal, plan: spec.plan!, baseDirectory: path.join(ctx.runDirectory, 'orch'),
    adapter, model: `${adapter.provider}/${adapter.model}`, maxWorkers: spec.execution.maxWorkers!,
    // 固定计划：不存在 planner 与整合修复 attempt，两项置 0，根 token 预算与 S 相同。
    rootBudget: {
      maxModelRequests: spec.budget.maxModelRequests, maxTotalTokens: spec.budget.maxTotalTokens,
      maxWallMs: spec.budget.maxWallMs, maxToolCalls: spec.budget.maxToolCalls, plannerShare: 0, fixReserveTokens: 0,
    },
    // 写入与 Bash 自动批准（§14.3：四臂以相同方式处理）；不提供 decide，冲突即停为需人工，计入该臂结果。
    approval: { writes: 'auto', bash: 'auto' },
    ...(runner ? { commandRunner: runner } : {}),
  })
  const loaded = await loadOrchestration(result.directory)
  const { state, events } = loaded
  const at = (type: string, attemptId: string) => events.find(event => event.type === type && (event.data as { attemptId?: string }).attemptId === attemptId)?.at
  let activeMs = 0
  for (const attemptId of state.attemptOrder) {
    const started = at('attempt/started', attemptId), finished = at('attempt/finished', attemptId)
    if (started && finished) activeMs += Date.parse(finished) - Date.parse(started)
  }
  return {
    status: result.status, directory: result.directory, activeMs, ...(result.error ? { error: result.error } : {}),
    orchestration: {
      status: result.status,
      attempts: state.attemptOrder.map(id => ({ subtaskId: state.attempts[id]!.subtaskId, status: state.attempts[id]!.status })),
      conflicts: state.integrations.reduce((sum, integration) => sum + integration.conflicts.length, 0),
      humanRequests: events.filter(event => event.type === 'human/requested').length,
      verificationsFailed: state.verifications.filter(verification => verification.exitCode !== 0).length,
    },
  }
}

export async function runArm(spec: RunSpec, ctx: RunContext): Promise<RunResult> {
  const now = ctx.now ?? Date.now
  await fsp.mkdir(ctx.runDirectory, { recursive: false })
  const repo = path.join(ctx.runDirectory, 'repo')
  await initialRepository(spec, repo)
  const { adapter, meter } = meteredAdapter(ctx.adapter, ctx.price)
  const started = now()
  let status: string, error: string | undefined, activeMs: number | undefined, target = repo
  let orchestration: RunResult['orchestration']
  try {
    if (spec.execution.kind === 'single-agent') {
      const outcome = await runSingleAgent(spec, ctx, repo, adapter)
      status = outcome.status
      error = outcome.error
    } else {
      const outcome = await runOrchestrated(spec, ctx, repo, adapter)
      status = outcome.status
      error = outcome.error
      activeMs = outcome.activeMs
      orchestration = outcome.orchestration
      target = path.join(outcome.directory, 'worktrees', 'integration')
    }
  } catch (cause) {
    status = 'infrastructure_error'
    error = cause instanceof Error ? cause.message : String(cause)
  }
  const wallMs = now() - started
  // 隐藏验收器是四臂共同的最终结论：S/D 在工作区副本上，R 在整合 worktree 上；没有整合产物即不通过。
  const hidden = fs.existsSync(target) ? await evaluateOrchestrationFixture(spec.taskId, target) : { passed: false, results: [] }
  const result: RunResult = {
    runId: spec.runId, taskId: spec.taskId, arm: spec.arm, repeat: spec.repeat, status, hidden, wallMs,
    activeMs: activeMs ?? wallMs, meter, ...(orchestration ? { orchestration } : {}), ...(error ? { error } : {}),
  }
  await fsp.writeFile(path.join(ctx.runDirectory, 'run.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' })
  return result
}

// ---------- 批次 ----------
export type BatchStopReason = 'completed' | 'amount_cap_before_request' | 'usage_unknown' | 'infrastructure_or_evidence_error'
export interface BatchOutcome { stopReason: BatchStopReason; runs: RunResult[]; spentUsd: number; calls: number }
export async function runBatch({ specs, evidenceRoot, adapter, price, maxUsd, commandRunnerFactory, onProgress, now }: {
  specs: readonly RunSpec[]; evidenceRoot: string; adapter: HarnessAdapter; price: BatchPrice; maxUsd: number
  commandRunnerFactory?: (workspace: string) => CommandRunner; onProgress?: (line: string) => void; now?: () => number
}): Promise<BatchOutcome> {
  const guard = createBatchAmountGuard(adapter.chat, price, maxUsd)
  const guarded: HarnessAdapter = { ...adapter, chat: guard.chat }
  const runs: RunResult[] = []
  let stopReason: BatchStopReason = 'completed'
  await fsp.mkdir(path.join(evidenceRoot, 'runs'), { recursive: true })
  for (const [index, spec] of specs.entries()) {
    const runDirectory = path.join(evidenceRoot, 'runs', `${String(index + 1).padStart(2, '0')}-${spec.runId.replaceAll(':', '_')}`)
    onProgress?.(`[${index + 1}/${specs.length}] ${spec.runId}`)
    let result: RunResult
    try {
      result = await runArm(spec, { runDirectory, adapter: guarded, price, ...(commandRunnerFactory ? { commandRunnerFactory } : {}), ...(now ? { now } : {}) })
    } catch (error) {
      onProgress?.(`  evidence error: ${error instanceof Error ? error.message : String(error)}`)
      stopReason = 'infrastructure_or_evidence_error'
      break
    }
    runs.push(result)
    onProgress?.(`  ${result.status}; hidden=${result.hidden.passed ? 'pass' : 'fail'}; requests=${result.meter.requests}; peakUsd=${result.meter.peakUsd.toFixed(4)}; batchSpent=${guard.spentUsd.toFixed(4)}`)
    // 立即停批（§14.4）：金额无法预留、未知用量、基础设施错误。预算内的模型失败不停批，记入该臂结果。
    if (guard.stopped === 'amount_limit') { stopReason = 'amount_cap_before_request'; break }
    if (guard.usageUnknown || result.meter.unknownUsageResponses > 0) { stopReason = 'usage_unknown'; break }
    if (result.status === 'infrastructure_error') { stopReason = 'infrastructure_or_evidence_error'; break }
  }
  return { stopReason, runs, spentUsd: guard.spentUsd, calls: guard.calls }
}

// ---------- 演练用脚本模型 ----------
// 不调用任何 provider。它为当前对话写入参考解、跑一次冒烟检查（经注入的隔离 runner），再给出报告；
// 先按目标文本认出是哪个夹具，worker 再缩到其 Write set，单 Agent 写该夹具全部目标。证明的是管线，不是模型能力。
export interface RehearsalTask { goal: string; targets: ReadonlyMap<string, string>; checks: readonly { target: string; command: string }[] }
export async function rehearsalTasks(ids: readonly OrchestrationFixtureId[], scratch: string): Promise<RehearsalTask[]> {
  const tasks: RehearsalTask[] = []
  for (const id of ids) {
    const fixture = orchestrationFixtures[id], reference = path.join(scratch, `reference-${id}`)
    await materializeOrchestrationFixture(id, reference, { reference: true })
    const targets = new Map<string, string>()
    for (const task of fixture.tasks) for (const file of task.writeSet) targets.set(file, await fsp.readFile(path.join(reference, file), 'utf8'))
    tasks.push({ goal: fixture.goal, targets, checks: fixture.tasks.map(task => ({ target: task.writeSet[0]!, command: task.check })) })
  }
  return tasks
}
export function rehearsalAdapter(tasks: readonly RehearsalTask[]): HarnessAdapter & { requests: () => number } {
  const usage: Usage = { inputTokens: 1_000, outputTokens: 100, totalTokens: 1_100, source: 'provider', uncertain: false, cacheReadTokens: 0 }
  let requests = 0, sequence = 0
  const text = (request: ChatRequest) => (request.messages ?? []).map(message => (typeof message.content === 'string' ? message.content : '')).join('\n')
  return {
    provider: 'scripted', model: 'rehearsal', capabilities: { rehearsal: { contextWindowTokens: batchContextWindowTokens } },
    requests: () => requests,
    chat: async request => {
      requests++
      const body = text(request)
      const task = tasks.find(candidate => body.includes(candidate.goal))
      if (!task) throw new Error('rehearsal adapter cannot identify the fixture for this request')
      // 无状态：步骤 = 对话里已有的 assistant 轮数。同一目标在不同 run 里重复出现也不会串步。
      const step = (request.messages ?? []).filter(message => message.role === 'assistant').length
      const writeSet = /Write set: (.+)/.exec(body)?.[1]?.split(', ').map(item => item.trim())
      const mine = [...task.targets.keys()].filter(target => !writeSet || writeSet.includes(target))
      if (step === 0) return { usage, toolCalls: mine.map(target => ({ id: `w${++sequence}`, name: 'write_file', arguments: { path: target, content: task.targets.get(target)! } })) }
      if (step === 1) {
        const command = task.checks.filter(check => mine.includes(check.target)).map(check => check.command).join(' && ')
        return { usage, toolCalls: [{ id: `b${++sequence}`, name: 'bash', arguments: { command } }] }
      }
      const content = writeSet
        ? `\`\`\`json\n${JSON.stringify({ status: 'done', summary: `wrote ${mine.join(', ')}`, uncertainties: [], sources: mine.map(target => ({ path: target })) })}\n\`\`\``
        : `Wrote ${mine.join(', ')} and ran the smoke checks.`
      return { usage, content, complete: true, finishReason: 'stop' }
    },
  }
}
