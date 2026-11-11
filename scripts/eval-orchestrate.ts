import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ChatRequest, ChatResponse } from '../src/core/contracts.js'
import {
  checkClauseVisibility, fixturePlan, orchestrationFixtureIds, orchestrationFixtures, validateOrchestrationFixture,
  type FixtureValidation, type OrchestrationFixtureId,
} from './orchestration-fixtures.js'
import os from 'node:os'
import dotenv from 'dotenv'
import { createDeepSeekAdapter } from '../src/models/deepseek.js'
import {
  batchContextWindowTokens, batchModel, freezeBatchManifest, gitState, manifestDigest, writeBatchManifest,
} from './eval-orchestrate-batch.js'
import { executeBatch, isolatedRunnerFactory, isolationPreflight, rehearseBatch, type ExecuteDeps } from './eval-orchestrate-run.js'

// 四臂对照（DEVELOPMENT.md §14.3/§14.4、TASKS M4-③/⑤）。`--validate-only`、`--plan-only`、`--rehearse`
// 都不创建真实模型适配器、不发起 provider 请求。`--execute` 是唯一会付费的模式：它只能在用户对**该次
// 批次**授权后运行，必须给出冻结 manifest、全新证据目录与金额上限，复跑是新批次、需再次授权。
export type ArmId = 'S' | 'D' | 'R' | 'R-serial'
export interface ArmDefinition {
  id: ArmId
  label: string
  execution: 'single-agent' | 'orchestration'
  delegation: 'off' | 'read-only'
  maxWorkers?: number
  difference: string
}
// D′（关闭治理）在 §14.3 中标注“可选”；时间不够时省略。这里明确列为未装配，而不是假装覆盖。
export const omittedArms = [{ id: 'D′', reason: 'optional in §14.3; deferred until the paid batch is authorized and the governance-off switch exists' }]
// §14.3 的任务表还有“冲突型”与“负对照”两类；本步只装配了组合并行与单任务两类。
// 不把它们写成已覆盖：预注册与夹具需要随付费批次一起提交。
export const omittedTaskCategories = [
  { category: 'conflict', reason: 'needs a registry-sharing fixture; deferred to the authorized batch preregistration' },
  { category: 'negative-control', reason: 'needs a small task expected not to split; deferred to the authorized batch preregistration' },
]
export const evalArms: readonly ArmDefinition[] = Object.freeze([
  { id: 'S', label: 'single-agent baseline', execution: 'single-agent', delegation: 'off', difference: 'baseline: one agent run per task' },
  { id: 'D', label: 'read-only delegation', execution: 'single-agent', delegation: 'read-only', difference: 'same agent, delegation.mode=read-only' },
  { id: 'R', label: 'full orchestration', execution: 'orchestration', delegation: 'off', maxWorkers: 2, difference: 'planner + parallel workers + host integration' },
  { id: 'R-serial', label: 'orchestration, one worker', execution: 'orchestration', delegation: 'off', maxWorkers: 1, difference: 'same orchestration plan with maxWorkers=1' },
])
// 整题预算在四臂间逐字相同（§14.3 公平性约束）。装配阶段只记录并比对，不执行。
export interface TaskBudget { maxModelRequests: number; maxTotalTokens: number; maxWallMs: number; maxToolCalls: number }
export const evalTaskBudget: TaskBudget = Object.freeze({ maxModelRequests: 96, maxTotalTokens: 1_000_000, maxWallMs: 30 * 60 * 1000, maxToolCalls: 192 })
export const evalRepeats = 2

// 哨兵适配器：装配阶段放入 spec，任何 chat 调用都会计数并使校验失败。
export interface ProviderSentinel { requests: number; adapter: { provider: string; model: string; capabilities: { sentinel: { contextWindowTokens: number } }; chat: (request: ChatRequest) => Promise<ChatResponse> } }
export function providerSentinel(): ProviderSentinel {
  const sentinel: ProviderSentinel = {
    requests: 0,
    adapter: {
      provider: 'sentinel', model: 'validate-only',
      capabilities: { sentinel: { contextWindowTokens: 100_000 } },
      chat: async () => { sentinel.requests++; throw new Error('provider call during --validate-only') },
    },
  }
  return sentinel
}

export interface RunSpec {
  runId: string
  taskId: OrchestrationFixtureId
  arm: ArmId
  repeat: number
  goal: string
  plan?: ReturnType<typeof fixturePlan>
  execution: { kind: ArmDefinition['execution']; delegation: ArmDefinition['delegation']; maxWorkers?: number }
  budget: TaskBudget
  model: string
  // 隐藏验收器是四臂共同的独立结论；S/D 在其工作区副本上运行，R 在整合 worktree 上运行。
  acceptance: { kind: 'hidden-verifier'; tasks: { taskId: string; script: string; target: string; marker: string }[] }
}
export function assembleRunMatrix({ tasks = orchestrationFixtureIds, arms = evalArms, repeats = evalRepeats, model = 'unset' }: {
  tasks?: readonly OrchestrationFixtureId[]; arms?: readonly ArmDefinition[]; repeats?: number; model?: string
} = {}): RunSpec[] {
  if (!Number.isSafeInteger(repeats) || repeats < 1) throw new Error('repeats must be a positive integer')
  const specs: RunSpec[] = []
  for (const taskId of tasks) for (const arm of arms) for (let repeat = 1; repeat <= repeats; repeat++) {
    const fixture = orchestrationFixtures[taskId]
    specs.push({
      runId: `${taskId}:${arm.id}:${repeat}`,
      taskId, arm: arm.id, repeat, goal: fixture.goal,
      ...(arm.execution === 'orchestration' ? { plan: fixturePlan(taskId) } : {}),
      execution: { kind: arm.execution, delegation: arm.delegation, ...(arm.maxWorkers === undefined ? {} : { maxWorkers: arm.maxWorkers }) },
      budget: { ...evalTaskBudget }, model,
      acceptance: {
        kind: 'hidden-verifier',
        tasks: fixture.tasks.map(task => ({ taskId: task.id, ...task.verify })),
      },
    })
  }
  return specs
}

export interface MatrixValidation { passed: boolean; errors: string[]; runs: number }
// 装配断言：同一任务的整题预算/目标/验收器在四臂间一致；R 与 R-serial 只差 maxWorkers；
// S 与 D 只差 delegation；repeats 与四臂齐全。它不调用任何模型。
export function validateRunMatrix(specs: readonly RunSpec[]): MatrixValidation {
  const errors: string[] = []
  const ids = new Set<string>()
  for (const spec of specs) {
    if (ids.has(spec.runId)) errors.push(`duplicate run id: ${spec.runId}`)
    ids.add(spec.runId)
    if (spec.acceptance.tasks.length === 0) errors.push(`run ${spec.runId} has no hidden verifier`)
    errors.push(...checkClauseVisibility(spec).errors)
  }
  const armsSeen = new Set(specs.map(spec => spec.arm))
  for (const arm of evalArms) if (!armsSeen.has(arm.id)) errors.push(`arm ${arm.id} is missing from the matrix`)
  for (const taskId of orchestrationFixtureIds) {
    const scoped = specs.filter(spec => spec.taskId === taskId)
    if (!scoped.length) { errors.push(`task ${taskId} is missing from the matrix`); continue }
    const reference = scoped[0]!
    for (const spec of scoped) {
      if (spec.goal !== reference.goal) errors.push(`${spec.runId} differs in goal`)
      if (JSON.stringify(spec.budget) !== JSON.stringify(reference.budget)) errors.push(`${spec.runId} differs in task budget`)
      if (JSON.stringify(spec.acceptance) !== JSON.stringify(reference.acceptance)) errors.push(`${spec.runId} differs in acceptance verifier`)
    }
    const r = scoped.find(spec => spec.arm === 'R')
    const serial = scoped.find(spec => spec.arm === 'R-serial')
    if (!r || !serial) errors.push(`task ${taskId} is missing R or R-serial`)
    else {
      if (r.execution.maxWorkers !== 2 || serial.execution.maxWorkers !== 1) errors.push(`task ${taskId} has wrong worker counts`)
      if (JSON.stringify({ kind: r.execution.kind, delegation: r.execution.delegation }) !== JSON.stringify({ kind: serial.execution.kind, delegation: serial.execution.delegation })) errors.push(`task ${taskId}: R and R-serial differ beyond maxWorkers`)
      if (JSON.stringify(r.plan) !== JSON.stringify(serial.plan)) errors.push(`task ${taskId}: R and R-serial do not share a plan`)
    }
    const s = scoped.find(spec => spec.arm === 'S')
    const d = scoped.find(spec => spec.arm === 'D')
    if (!s || !d) errors.push(`task ${taskId} is missing S or D`)
    else {
      if (s.execution.delegation !== 'off' || d.execution.delegation !== 'read-only') errors.push(`task ${taskId}: S/D delegation flags are wrong`)
      if (s.execution.kind !== 'single-agent' || d.execution.kind !== 'single-agent') errors.push(`task ${taskId}: S/D must run the single-agent path`)
      if (s.plan || d.plan) errors.push(`task ${taskId}: S/D must not receive an orchestration plan`)
    }
  }
  return { passed: errors.length === 0, errors, runs: specs.length }
}

export interface OfflineBatch {
  mode: 'validate-only'
  providerRequests: 0
  model: string
  tasks: FixtureValidation[]
  runs: number
  repeats: number
  arms: readonly ArmDefinition[]
  omitted: typeof omittedArms
  omittedTaskCategories: typeof omittedTaskCategories
  matrix: MatrixValidation
  paidBatch: { executed: false; reason: string }
  passed: boolean
}
// 零付费校验 = 夹具正反例 + 四臂矩阵装配。两者都只读写本地文件；sentinel 的 chat 从未被调用。
export async function validateOfflineBatch({ model = 'unset' }: { model?: string } = {}): Promise<OfflineBatch> {
  const tasks = await Promise.all(orchestrationFixtureIds.map(id => validateOrchestrationFixture(id)))
  const sentinel = providerSentinel()
  const specs = assembleRunMatrix({ model })
  // spec 里保留哨兵适配器形状的 provider 字段；装配阶段不实例化任何会调用 chat 的对象。
  const matrix = validateRunMatrix(specs)
  if (sentinel.requests !== 0) throw new Error('provider sentinel was called during offline validation')
  for (const task of tasks) {
    if (!task.initialRejected) matrix.errors.push(`task ${task.id}: initial state was accepted`)
    if (!task.referenceAccepted) matrix.errors.push(`task ${task.id}: reference state was rejected`)
    if (!task.weakRejected) matrix.errors.push(`task ${task.id}: weak counter-example was accepted`)
  }
  if (matrix.errors.length) matrix.passed = false
  return {
    mode: 'validate-only', providerRequests: 0, model, tasks, runs: specs.length, repeats: evalRepeats,
    arms: evalArms, omitted: omittedArms, omittedTaskCategories, matrix,
    paidBatch: { executed: false, reason: 'a paid batch needs explicit authorization for that batch (§14.4); resume/re-runs are new batches' },
    passed: matrix.passed && sentinel.requests === 0,
  }
}

export type EvalMode = 'validate-only' | 'plan-only' | 'rehearse' | 'execute'
export interface CliOptions { mode: EvalMode; model: string; manifestOut?: string; evidenceRoot?: string; manifest?: string; maxUsd?: number }
// `--execute` 是唯一会付费的模式：它只接受 manifest 冻结的模型，并且必须同时给出 manifest、全新证据目录与金额上限。
export function parseEvalArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
  let model = env.MINI_DSH_EVAL_MODEL ?? 'unset'
  const modes: EvalMode[] = []
  let manifestOut: string | undefined, evidenceRoot: string | undefined, manifest: string | undefined, maxUsdText: string | undefined
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--validate-only') modes.push('validate-only')
    else if (arg === '--plan-only') modes.push('plan-only')
    else if (arg === '--rehearse') modes.push('rehearse')
    else if (arg === '--execute') modes.push('execute')
    else if (arg === '--model' || arg === '--manifest-out' || arg === '--evidence-root' || arg === '--manifest' || arg === '--max-usd') {
      const value = argv[++index]
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`)
      if (arg === '--model') model = value
      else if (arg === '--manifest-out') manifestOut = value
      else if (arg === '--evidence-root') evidenceRoot = value
      else if (arg === '--manifest') manifest = value
      else maxUsdText = value
    } else throw new Error(`unknown argument: ${arg}`)
  }
  if (modes.length !== 1) throw new Error('choose exactly one of --validate-only, --plan-only, --rehearse or --execute')
  const mode = modes[0]!
  if (manifestOut !== undefined && mode !== 'plan-only') throw new Error('--manifest-out is only valid with --plan-only')
  if (evidenceRoot !== undefined && mode !== 'rehearse' && mode !== 'execute') throw new Error('--evidence-root is only valid with --rehearse or --execute')
  if ((manifest !== undefined || maxUsdText !== undefined) && mode !== 'execute') throw new Error('--manifest and --max-usd are only valid with --execute')
  if (mode === 'execute') {
    if (model !== 'unset') throw new Error('--execute takes its model from the frozen manifest; do not pass --model or MINI_DSH_EVAL_MODEL')
    if (manifest === undefined || evidenceRoot === undefined || maxUsdText === undefined) throw new Error('--execute requires --manifest, --evidence-root and --max-usd')
    const maxUsd = Number(maxUsdText)
    if (!/^\d+(\.\d+)?$/.test(maxUsdText) || !Number.isFinite(maxUsd) || maxUsd <= 0) throw new Error('--max-usd must be a positive decimal amount')
    return { mode, model: 'from-manifest', manifest, evidenceRoot, maxUsd }
  }
  if (mode === 'plan-only' || mode === 'rehearse') {
    if (model === 'unset') model = batchModel
    if (model !== batchModel) throw new Error(`this batch is preregistered for ${batchModel}; got ${model}`)
  }
  return { mode, model, ...(manifestOut === undefined ? {} : { manifestOut }), ...(evidenceRoot === undefined ? {} : { evidenceRoot }) }
}

// 真实依赖只在 CLI 里装配：DeepSeek 适配器（与 eval-v2-run 同形：显式模型列表与 1M 窗口，thinking 取适配器
// 缺省，与生产 CLI 相同）与直连探测。测试注入脚本依赖，从不经过这里。
function realExecuteDeps(): ExecuteDeps {
  const baseUrl = 'https://api.deepseek.com'
  return {
    env: process.env, repository: repositoryRoot, preflight: isolationPreflight, runnerFactory: isolatedRunnerFactory,
    onProgress: line => console.error(line),
    createAdapter: (apiKey, modelId) => {
      const base = createDeepSeekAdapter({ apiKey, models: [modelId], contextWindowTokens: batchContextWindowTokens })
      return { provider: 'deepseek', model: modelId, ...(base.capabilities ? { capabilities: base.capabilities } : {}), chat: request => base.chat(request) }
    },
    directProbe: async (apiKey, modelId) => {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelId, max_tokens: 16, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: 'reply with the single word: ok' }] }),
        signal: AbortSignal.timeout(60_000),
      })
      if (!response.ok) throw new Error(`model probe failed: HTTP ${response.status}`)
      const direct = await response.json() as { model?: string; usage?: unknown; choices?: { finish_reason?: string }[] }
      return { ...(direct.model ? { model: direct.model } : {}), usage: direct.usage, ...(direct.choices?.[0]?.finish_reason ? { finishReason: direct.choices[0].finish_reason } : {}) }
    },
  }
}

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))
// 只打印将要执行的批次（矩阵、预算、模型、价格快照、金额上限）；给出 --manifest-out 时冻结 manifest。
// 两者都不创建适配器、不读 API key。冻结要求干净工作树，记录的 commit 才是将要执行的代码。
export async function planBatch({ model = batchModel, manifestOut, repository = repositoryRoot, now = () => new Date() }: {
  model?: string; manifestOut?: string; repository?: string; now?: () => Date
} = {}) {
  const specs = assembleRunMatrix({ model })
  const matrix = validateRunMatrix(specs)
  if (!matrix.passed) throw new Error(`run matrix is invalid: ${matrix.errors.join('; ')}`)
  const git = gitState(repository)
  const manifest = freezeBatchManifest({ specs, gitCommit: git.head, createdAt: now().toISOString(), model })
  if (manifestOut !== undefined) {
    if (git.dirty) throw new Error('refusing to freeze a batch manifest from a dirty working tree')
    await writeBatchManifest(manifestOut, manifest)
  }
  return {
    mode: 'plan-only' as const, providerRequests: 0 as const, dirty: git.dirty,
    manifestWritten: manifestOut ?? null, manifestDigest: manifestDigest(manifest), manifest,
  }
}

async function main() {
  let options: CliOptions
  try { options = parseEvalArgs(process.argv.slice(2)) } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 2
    return
  }
  if (options.mode === 'execute') {
    try {
      dotenv.config({ quiet: true })
      const result = await executeBatch({ manifestPath: options.manifest!, evidenceRoot: options.evidenceRoot!, maxUsd: options.maxUsd! }, realExecuteDeps())
      console.log(JSON.stringify({ mode: 'execute', stopReason: result.stopReason, passed: result.passed, evidenceRoot: result.evidenceRoot, ...('report' in result && result.report ? { executedRuns: result.report.executedRuns, spentPeakUsd: result.report.spentPeakUsd, byArm: result.report.summary.byArm } : {}) }, null, 2))
      if (!result.passed) process.exitCode = 1
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
    return
  }
  if (options.mode === 'rehearse') {
    try {
      const specs = assembleRunMatrix({ model: options.model })
      const manifest = freezeBatchManifest({ specs, gitCommit: gitState(repositoryRoot).head, createdAt: new Date().toISOString(), model: options.model })
      const evidenceRoot = options.evidenceRoot ?? path.join(os.tmpdir(), `mini-dsh-orch-rehearse-${Date.now()}`)
      const runtimeRoot = process.env.MINI_DSH_V2_RUNTIME
      const result = await rehearseBatch({ manifest, specs, evidenceRoot, ...(runtimeRoot ? { runtimeRoot } : {}), onProgress: line => console.error(line) })
      const { report } = result
      console.log(JSON.stringify({ mode: 'rehearse', passed: result.passed, providerRequests: 0, scriptedRequests: result.scriptedRequests, isolation: report.isolation, stopReason: report.stopReason, executedRuns: report.executedRuns, byArm: report.summary.byArm, evidenceRoot: result.evidenceRoot }, null, 2))
      if (!result.passed) process.exitCode = 1
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
    return
  }
  if (options.mode === 'plan-only') {
    try {
      console.log(JSON.stringify(await planBatch({ model: options.model, ...(options.manifestOut ? { manifestOut: options.manifestOut } : {}) }), null, 2))
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
    return
  }
  const report = await validateOfflineBatch({ model: options.model })
  console.log(JSON.stringify(report, null, 2))
  if (!report.passed) process.exitCode = 1
}
const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) await main()
