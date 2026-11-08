import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { HarnessAdapter } from '../src/app/create-harness.js'
import {
  rehearsalAdapter, rehearsalTasks, runBatch, type BatchOutcome, type CommandRunner, type RunResult,
} from './eval-orchestrate-arms.js'
import {
  assertBatchPrice, batchExecutionOrder, batchProtocol, batchReserveUsd, gitState, matrixDigest, type BatchManifest,
} from './eval-orchestrate-batch.js'
// 与 CLI 入口互相导入：这里只在函数体内使用 assembleRunMatrix，模块求值顺序不影响。
import { assembleRunMatrix, type ArmId, type RunSpec } from './eval-orchestrate.js'
import { createIsolatedCommandRunner, createIsolationBackend } from './eval-v2-isolation.js'
import { orchestrationFixtureIds } from './orchestration-fixtures.js'

// 批次执行入口（TASKS M4-⑤-2/⑤-3）：隔离 preflight、演练、付费执行与报告。演练只注入脚本模型（provider
// 请求恒为 0）；付费执行的适配器与探测由 CLI 注入，本模块不读 .env、不直接发请求。

// 与 eval-v2-run 的 preflight 同一检查（Linux Node v22.22.1 可用、宿主哨兵文件不可读）。不直接改动
// eval-v2-run：它在 eval-v2 的冻结文件清单里，改动会使旧 manifest 失效。
export async function isolationPreflight(runtimeRoot: string) {
  if (!(await fs.stat(runtimeRoot).catch(() => undefined))?.isDirectory()) throw new Error('MINI_DSH_V2_RUNTIME must point to the pinned extracted Linux runtime')
  const preflight = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-orch-preflight-'))
  const sentinel = path.join(path.dirname(preflight), `${path.basename(preflight)}-hidden.txt`)
  try {
    await fs.writeFile(sentinel, 'host-only', { flag: 'wx' })
    const backend = createIsolationBackend({ workspace: preflight, runtimeRoot })
    const capabilities = await backend.preflight()
    const result = await backend.run({
      executable: 'ignored', args: [], command: `node --version && test ! -r '${backend.visibleHostPath(sentinel)}'`, cwd: preflight,
      signal: new AbortController().signal, timeoutMs: 10_000,
    })
    if (result.status !== 'exited' || result.exitCode !== 0 || !result.stdout.text.includes('v22.22.1')) throw new Error(`orchestration isolation preflight failed (${capabilities.kind})`)
    return capabilities.kind
  } finally {
    await fs.rm(sentinel, { force: true })
    await fs.rm(preflight, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  }
}
export const isolatedRunnerFactory = (runtimeRoot: string) => (workspace: string): CommandRunner => createIsolatedCommandRunner({ workspace, runtimeRoot })

// ---------- 报告 ----------
// 只陈述实测：逐 (任务, 重复) 配对的原始数字与按臂汇总，不做显著性判断。USD 按峰值价估算，是上界。
export interface ArmSummary { runs: number; hiddenPassed: number; meanWallMs: number; meanActiveMs: number; requests: number; bashCalls: number; peakUsd: number }
export function summarizeRuns(runs: readonly RunResult[]) {
  const byArm: Partial<Record<ArmId, ArmSummary>> = {}
  for (const run of runs) {
    const arm = byArm[run.arm as ArmId] ?? { runs: 0, hiddenPassed: 0, meanWallMs: 0, meanActiveMs: 0, requests: 0, bashCalls: 0, peakUsd: 0 }
    byArm[run.arm as ArmId] = arm
    arm.runs++
    if (run.hidden.passed) arm.hiddenPassed++
    arm.meanWallMs += run.wallMs
    arm.meanActiveMs += run.activeMs
    arm.requests += run.meter.requests
    arm.bashCalls += run.meter.bashCalls
    arm.peakUsd += run.meter.peakUsd
  }
  for (const arm of Object.values(byArm)) { arm.meanWallMs /= arm.runs; arm.meanActiveMs /= arm.runs }
  const pairs: Record<string, Partial<Record<ArmId, { status: string; passed: boolean; wallMs: number; activeMs: number; requests: number; peakUsd: number }>>> = {}
  for (const run of runs) {
    const key = `${run.taskId}:${run.repeat}`
    const pair = pairs[key] ?? {}
    pair[run.arm as ArmId] = { status: run.status, passed: run.hidden.passed, wallMs: run.wallMs, activeMs: run.activeMs, requests: run.meter.requests, peakUsd: run.meter.peakUsd }
    pairs[key] = pair
  }
  return { byArm, pairs }
}
export interface BatchReport {
  mode: 'rehearse' | 'execute'
  protocol: string
  model: string
  observedModel?: string
  isolation: string
  startedAt: string
  finishedAt: string
  stopReason: BatchOutcome['stopReason']
  plannedRuns: number
  executedRuns: number
  calls: number
  spentPeakUsd: number
  summary: ReturnType<typeof summarizeRuns>
  runs: RunResult[]
  notes: string[]
}
export async function writeBatchReport(evidenceRoot: string, report: BatchReport) {
  await fs.writeFile(path.join(evidenceRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
}

// ---------- 证据目录 ----------
// 一次批次一个目录：已存在即拒绝（复跑是新批次，换目录并重新授权）。
export async function createEvidenceRoot(evidenceRoot: string) {
  const resolved = path.resolve(evidenceRoot)
  if (await fs.stat(resolved).catch(() => undefined)) throw new Error(`evidence root already exists: ${resolved}; a re-run is a new batch and needs a new directory`)
  await fs.mkdir(resolved, { recursive: false })
  return resolved
}

// ---------- 演练 ----------
// 16 runs 全走真实工作区、真实 git/worktree、（给出运行时时）真实 WSL bwrap 隔离与金额守卫，模型换成脚本。
export async function rehearseBatch({ manifest, specs, evidenceRoot, runtimeRoot, onProgress }: {
  manifest: BatchManifest; specs: readonly RunSpec[]; evidenceRoot: string; runtimeRoot?: string; onProgress?: (line: string) => void
}) {
  const root = await createEvidenceRoot(evidenceRoot)
  const isolation = runtimeRoot ? await isolationPreflight(runtimeRoot) : 'host (no MINI_DSH_V2_RUNTIME; Bash is not isolated)'
  const tasks = await rehearsalTasks(orchestrationFixtureIds, path.join(root, 'scratch'))
  const adapter: HarnessAdapter & { requests: () => number } = rehearsalAdapter(tasks)
  const startedAt = new Date().toISOString()
  const outcome = await runBatch({
    specs: batchExecutionOrder(specs), evidenceRoot: root, adapter, price: manifest.price, maxUsd: manifest.reserve.batchUsd,
    ...(runtimeRoot ? { commandRunnerFactory: isolatedRunnerFactory(runtimeRoot) } : {}),
    ...(onProgress ? { onProgress } : {}),
  })
  const report: BatchReport = {
    mode: 'rehearse', protocol: manifest.protocol, model: 'scripted/rehearsal', isolation, startedAt, finishedAt: new Date().toISOString(),
    stopReason: outcome.stopReason, plannedRuns: specs.length, executedRuns: outcome.runs.length, calls: outcome.calls,
    spentPeakUsd: outcome.spentUsd, summary: summarizeRuns(outcome.runs), runs: outcome.runs,
    notes: ['scripted model writes the reference solution; this proves the pipeline, not model capability', 'providerRequests=0', ...manifest.notes],
  }
  await writeBatchReport(root, report)
  const passed = outcome.stopReason === 'completed' && outcome.runs.length === specs.length && outcome.runs.every(run => run.hidden.passed)
  return { evidenceRoot: root, providerRequests: 0 as const, scriptedRequests: adapter.requests(), passed, report }
}

// ---------- 付费执行（TASKS M4-⑤-3）----------
// 只在用户对**该次批次**授权后运行；复跑是新批次。全部闸门在创建证据目录与发出任何请求之前完成。
export interface ExecuteDeps {
  env: NodeJS.ProcessEnv
  repository: string
  createAdapter: (apiKey: string, modelId: string) => HarnessAdapter
  directProbe: (apiKey: string, modelId: string) => Promise<{ model?: string; usage?: unknown; finishReason?: string }>
  preflight: (runtimeRoot: string) => Promise<string>
  runnerFactory: (runtimeRoot: string) => (workspace: string) => CommandRunner
  onProgress?: (line: string) => void
}
export interface ExecuteOptions { manifestPath: string; evidenceRoot: string; maxUsd: number }

const close = (a: number, b: number) => Math.abs(a - b) < 1e-9
// manifest 必须与当前代码重新装配出的矩阵逐项一致：digest、执行顺序、金额上限；HEAD 干净且等于冻结 commit。
export async function verifyManifestForExecute(manifestPath: string, repository: string) {
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as BatchManifest
  if (manifest.protocol !== batchProtocol) throw new Error(`manifest protocol must be ${batchProtocol}`)
  assertBatchPrice(manifest.price)
  const specs = assembleRunMatrix({ model: manifest.model })
  if (matrixDigest(specs) !== manifest.matrixDigest) throw new Error('manifest matrix digest does not match the current run matrix')
  const ordered = batchExecutionOrder(specs)
  if (JSON.stringify(ordered.map(spec => spec.runId)) !== JSON.stringify(manifest.runOrder)) throw new Error('manifest run order does not match')
  const reserve = batchReserveUsd(specs, manifest.price, manifest.maxOutputTokens)
  if (!close(reserve.batchUsd, manifest.reserve.batchUsd) || !close(reserve.perRunUsd, manifest.reserve.perRunUsd)) throw new Error('manifest cost ceiling does not match the frozen price and budget')
  const git = gitState(repository)
  if (git.dirty) throw new Error('refusing a paid batch from a dirty working tree')
  if (git.head !== manifest.gitCommit) throw new Error(`HEAD ${git.head} is not the frozen commit ${manifest.gitCommit}`)
  return { manifest, ordered }
}

export async function executeBatch(options: ExecuteOptions, deps: ExecuteDeps) {
  const { manifest, ordered } = await verifyManifestForExecute(options.manifestPath, deps.repository)
  const { probeUsd, perRunUsd, batchUsd } = manifest.reserve
  if (!Number.isFinite(options.maxUsd) || options.maxUsd < probeUsd + perRunUsd) throw new Error(`--max-usd must cover the probe and one run: at least $${(probeUsd + perRunUsd).toFixed(2)}`)
  if (options.maxUsd > batchUsd + 1e-9) throw new Error(`--max-usd exceeds the frozen batch ceiling $${batchUsd.toFixed(2)}`)
  const apiKey = deps.env.DEEPSEEK_API_KEY
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY is required for a paid batch')
  const runtimeRoot = deps.env.MINI_DSH_V2_RUNTIME
  if (!runtimeRoot) throw new Error('MINI_DSH_V2_RUNTIME is required: paid runs execute Bash only inside the Linux isolation')
  const isolation = await deps.preflight(runtimeRoot)
  const root = await createEvidenceRoot(options.evidenceRoot)
  await fs.writeFile(path.join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
  await fs.copyFile(path.join(deps.repository, 'package.json'), path.join(root, 'package.json')).catch(() => {})

  const modelId = manifest.model.replace(/^deepseek\//, '')
  const adapter = deps.createAdapter(apiKey, modelId)
  const startedAt = new Date().toISOString()
  const baseReport = {
    mode: 'execute' as const, protocol: manifest.protocol, model: manifest.model, isolation, startedAt, plannedRuns: ordered.length,
    notes: [`maxUsd=${options.maxUsd}`, 'USD is estimated at peak prices and is an upper bound', ...manifest.notes],
  }
  let observedModel: string | undefined
  try {
    const direct = await deps.directProbe(apiKey, modelId)
    if (direct.model !== manifest.echoedModel || !direct.usage) throw new Error(`model probe mismatch: expected ${manifest.echoedModel}, observed ${String(direct.model)}`)
    const streamed = await adapter.chat({ model: modelId, maxOutputTokens: 1024, messages: [{ role: 'user', content: 'reply with the single word: ok' }] })
    if (streamed.usage?.source !== 'provider' || streamed.complete === false) throw new Error('streaming model probe returned no complete provider usage')
    observedModel = streamed.observedModel
    await fs.writeFile(path.join(root, 'probe.json'), `${JSON.stringify({ requestedModel: modelId, echoedModel: direct.model, directUsage: direct.usage, directFinishReason: direct.finishReason, streamedUsage: streamed.usage, streamedObservedModel: streamed.observedModel, reservedUsd: probeUsd }, null, 2)}\n`, { flag: 'wx' })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await fs.writeFile(path.join(root, 'probe-error.json'), `${JSON.stringify({ error: message, reservedUsd: probeUsd })}\n`, { flag: 'wx' })
    await fs.writeFile(path.join(root, 'report.json'), `${JSON.stringify({ ...baseReport, finishedAt: new Date().toISOString(), stopReason: 'protocol_probe_failed', executedRuns: 0, spentPeakUsd: probeUsd, error: message }, null, 2)}\n`, { flag: 'wx' })
    return { evidenceRoot: root, stopReason: 'protocol_probe_failed' as const, passed: false }
  }
  // 探测预留整额计入已花费；批次守卫只拿剩余额度。
  const outcome = await runBatch({
    specs: ordered, evidenceRoot: root, adapter, price: manifest.price, maxUsd: options.maxUsd - probeUsd,
    commandRunnerFactory: deps.runnerFactory(runtimeRoot), ...(deps.onProgress ? { onProgress: deps.onProgress } : {}),
  })
  const report: BatchReport = {
    ...baseReport, ...(observedModel ? { observedModel } : {}), finishedAt: new Date().toISOString(),
    stopReason: outcome.stopReason, executedRuns: outcome.runs.length, calls: outcome.calls,
    spentPeakUsd: probeUsd + outcome.spentUsd, summary: summarizeRuns(outcome.runs), runs: outcome.runs,
  }
  await writeBatchReport(root, report)
  return { evidenceRoot: root, stopReason: outcome.stopReason, passed: outcome.stopReason === 'completed', report }
}
