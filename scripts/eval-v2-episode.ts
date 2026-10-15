import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { BudgetStop, emptyCounters } from '../src/core/budget.js'
import type { BudgetPolicy, Counters, RunState, StopReason } from '../src/core/budget.js'

export interface V2StageRecord {
  index: number
  contractHash: string
  taskId?: string
  runId?: string
  status: StopReason | 'running'
  counters: Counters
  cumulative: Counters
  snapshotHash: string
  snapshotPath: string
  error?: string
}

export interface V2EpisodeResult {
  status: StopReason
  counters: Counters
  stages: V2StageRecord[]
  error?: string
  tokenOvershoot: number
}

const sum = (a: Counters, b: Counters): Counters => ({
  modelRequests: a.modelRequests + b.modelRequests,
  toolCalls: a.toolCalls + b.toolCalls,
  toolErrors: a.toolErrors + b.toolErrors,
  previewTruncations: a.previewTruncations + b.previewTruncations,
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  totalTokens: a.totalTokens + b.totalTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  activeDurationMs: a.activeDurationMs + b.activeDurationMs,
  approvalDurationMs: a.approvalDurationMs + b.approvalDurationMs,
})

export function remainingEpisodeBudget(policy: Readonly<BudgetPolicy>, used: Counters, elapsedMs: number): BudgetPolicy {
  const remainder = (limit: number | undefined, spent: number) => limit === undefined ? undefined : Math.max(0, limit - spent)
  return {
    ...policy,
    maxModelRequests: remainder(policy.maxModelRequests, used.modelRequests),
    maxToolCalls: remainder(policy.maxToolCalls, used.toolCalls),
    maxTotalTokens: remainder(policy.maxTotalTokens, used.totalTokens),
    maxActiveDurationMs: remainder(policy.maxActiveDurationMs, Math.ceil(elapsedMs)),
  }
}

function exhausted(policy: BudgetPolicy): StopReason | undefined {
  if (policy.maxActiveDurationMs === 0) return 'timeout'
  if (policy.maxTotalTokens === 0) return 'token_budget'
  if (policy.maxModelRequests === 0) return 'max_steps'
  if (policy.maxToolCalls === 0) return 'max_tool_calls'
  return undefined
}

export async function snapshotWorkspace(workspace: string, directory: string, index: number): Promise<{ path: string; hash: string }> {
  const target = path.join(directory, String(index).padStart(2, '0'))
  const relative = path.relative(workspace, target)
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) throw new Error('snapshot target must be outside candidate workspace')
  await fs.mkdir(directory, { recursive: true })
  await fs.cp(workspace, target, { recursive: true, errorOnExist: true, force: false, filter: async source => {
    const stat = await fs.lstat(source)
    if (stat.isSymbolicLink()) throw new Error(`snapshot rejects symbolic link: ${source}`)
    return true
  } })
  const hash = createHash('sha256')
  async function visit(current: string, prefix: string): Promise<void> {
    for (const entry of (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.posix.join(prefix, entry.name)
      if (entry.isDirectory()) await visit(path.join(current, entry.name), name)
      else if (entry.isFile()) {
        hash.update(name); hash.update('\0'); hash.update(await fs.readFile(path.join(current, entry.name))); hash.update('\0')
      } else throw new Error(`snapshot contains unsupported entry: ${name}`)
    }
  }
  await visit(target, '')
  return { path: target, hash: hash.digest('hex') }
}

export async function runV2Stages(options: {
  tasks: readonly string[]
  policy: Readonly<BudgetPolicy>
  send: (task: string, budget: BudgetPolicy, signal: AbortSignal) => Promise<void>
  latestRun: () => RunState | undefined
  snapshot: (index: number) => Promise<{ path: string; hash: string }>
  now?: () => number
}): Promise<V2EpisodeResult> {
  const now = options.now ?? (() => performance.now())
  const started = now(), controller = new AbortController()
  let timedOut = false, cumulative = emptyCounters(), error: string | undefined
  let status: StopReason = 'completed'
  const stages: V2StageRecord[] = []
  const timeout = options.policy.maxActiveDurationMs === undefined ? undefined : setTimeout(() => {
    timedOut = true
    controller.abort()
  }, options.policy.maxActiveDurationMs)
  try {
    for (const [index, task] of options.tasks.entries()) {
      const remaining = remainingEpisodeBudget(options.policy, cumulative, now() - started)
      const stop = exhausted(remaining)
      if (stop || controller.signal.aborted) { status = stop ?? 'timeout'; break }
      const previousRunId = options.latestRun()?.runId
      let causeError: string | undefined, budgetStop: StopReason | undefined
      try { await options.send(task, remaining, controller.signal) } catch (cause) {
        if (cause instanceof BudgetStop) budgetStop = cause.reason
        else causeError = cause instanceof Error ? cause.message : String(cause)
      }
      const latest = options.latestRun()
      const state = latest?.runId === previousRunId ? undefined : latest
      const stageStatus = state?.status ?? budgetStop ?? 'error'
      cumulative = sum(cumulative, state?.counters ?? emptyCounters())
      // A failed snapshot is an evidence failure: propagate it rather than returning a seemingly valid result.
      const snapshot = await options.snapshot(index + 1)
      stages.push({
        index: index + 1, contractHash: createHash('sha256').update(task).digest('hex'),
        ...(state ? { taskId: state.taskId, runId: state.runId } : {}),
        status: stageStatus, counters: state?.counters ?? emptyCounters(), cumulative: { ...cumulative },
        snapshotHash: snapshot.hash, snapshotPath: snapshot.path,
        ...(causeError ? { error: causeError } : {}),
      })
      if (causeError || stageStatus !== 'completed' || timedOut) {
        status = timedOut ? 'timeout' : causeError || stageStatus === 'running' ? 'error' : stageStatus
        error = causeError
        break
      }
    }
    if (timedOut) status = 'timeout'
    return { status, counters: cumulative, stages, ...(error ? { error } : {}), tokenOvershoot: Math.max(0, cumulative.totalTokens - (options.policy.maxTotalTokens ?? Infinity)) }
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}
