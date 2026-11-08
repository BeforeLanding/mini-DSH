import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { HarnessAdapter } from '../src/app/create-harness.js'
import {
  rehearsalAdapter, rehearsalTasks, runBatch, type BatchOutcome, type CommandRunner, type RunResult,
} from './eval-orchestrate-arms.js'
import { batchExecutionOrder, type BatchManifest } from './eval-orchestrate-batch.js'
import type { ArmId, RunSpec } from './eval-orchestrate.js'
import { createIsolatedCommandRunner, createIsolationBackend } from './eval-v2-isolation.js'
import { orchestrationFixtureIds } from './orchestration-fixtures.js'

// 批次执行入口（TASKS M4-⑤-2/⑤-3）：隔离 preflight、演练与报告。真实模型执行在 ⑤-3 接入；本文件的
// 演练只注入脚本模型，provider 请求恒为 0。

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
