import { spawnSync } from 'node:child_process'
import { commandInterpreter } from './command-environment.js'
import type { CommandEnvironment } from './command-environment.js'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Usage } from '../../src/core/budget.js'
import { buildExternalRunArgs, externalLabels } from './external-contract.js'
import type { ExternalLabels } from './external-contract.js'
import type { EpisodeStatus, PriceSnapshot, SwebenchArm, SwebenchInstance, SwebenchPrediction } from './protocol.js'
import { usageCost } from './protocol.js'

export interface ExternalCaps {
  maxCostUsd: number
  maxModelRequests: number
  maxToolCalls: number
  wallClockMs: number
  maxOutputTokens: number
  // Same derived cap the mini-DSH harness uses for a task (input + output).
  maxTotalTokens: number
}

export interface ExternalPaths {
  episodeDirectory: string
  workspace: string
  datasetDirectory: string
  configPath: string
  outputDirectory: string
  upstreamConfigPath: string
}

export interface ExternalUsageReading {
  usage: Usage[]
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  modelRequests: number
  toolCalls: number
  miniApiCalls: number | null
  reportedCostUsd: number | null
  unknown: boolean
  reasons: string[]
}

export interface ExternalPredictionReading {
  prediction?: SwebenchPrediction
  path: string
  sha256?: string
  reasons: string[]
}

const goldFields = ['patch', 'test_patch', 'FAIL_TO_PASS', 'PASS_TO_PASS', 'hints_text'] as const
const hashPattern = /^[0-9a-f]{64}$/

export function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex')
}

export async function sha256File(file: string): Promise<string> {
  return sha256(await fs.readFile(file))
}

// Only the sanitized runtime fields plus the digest-pinned image. A hidden test
// patch can never reach the baseline through this row.
export function externalDatasetRow(instance: SwebenchInstance, image: string): Record<string, string> {
  if (!instance.problem_statement?.trim()) throw new Error(`instance ${instance.instance_id} lacks a problem statement`)
  if (!image) throw new Error(`instance ${instance.instance_id} lacks an image digest`)
  const row: Record<string, string> = {
    instance_id: instance.instance_id,
    repo: instance.repo,
    base_commit: instance.base_commit,
    problem_statement: instance.problem_statement,
    image_name: image,
  }
  if (instance.version) row.version = instance.version
  if (instance.environment_setup_commit) row.environment_setup_commit = instance.environment_setup_commit
  for (const field of goldFields) if (field in row) throw new Error(`external dataset row contains hidden field ${field}`)
  return row
}

export function externalLitellmModel(arm: SwebenchArm): string {
  if (!arm.model.name) throw new Error(`external arm ${arm.id} needs a model name`)
  return `${arm.model.provider}/${arm.model.name}`
}

export function externalOverrideConfig(input: {
  model: string
  caps: ExternalCaps
  paths: ExternalPaths
  uid: number
  gid: number
  labels: ExternalLabels
  modelClass?: string
  modelExtra?: Record<string, unknown>
  commandEnvironment?: CommandEnvironment
}): Record<string, unknown> {
  const { model, caps, paths, uid, gid, labels, modelClass, modelExtra } = input
  const runArgs = buildExternalRunArgs({ workspace: paths.workspace, uid, gid, labels })
  return {
    agent: {
      step_limit: caps.maxModelRequests,
      cost_limit: caps.maxCostUsd,
      wall_time_limit_seconds: Math.max(1, Math.ceil(caps.wallClockMs / 1000)),
      output_path: path.join(paths.outputDirectory, 'live.traj.json'),
    },
    environment: {
      environment_class: 'docker',
      cwd: '/testbed',
      timeout: 30,
      interpreter: commandInterpreter(input.commandEnvironment),
      env: {
        HOME: '/tmp',
        PAGER: 'cat',
        MANPAGER: 'cat',
        LESS: '-R',
        PIP_PROGRESS_BAR: 'off',
        TQDM_DISABLE: '1',
        BASH_ENV: '',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'safe.directory',
        GIT_CONFIG_VALUE_0: '/testbed',
      },
      forward_env: [],
      run_args: runArgs,
      container_timeout: '2h',
      pull_timeout: 900,
    },
    model: {
      model_class: modelClass ?? 'litellm',
      model_name: model,
      model_kwargs: { drop_params: true, parallel_tool_calls: true, max_tokens: caps.maxOutputTokens,
        // The candidate adapter enables DeepSeek thinking by default; keep the
        // baseline on the same model-side setting and record it in the config.
        thinking: { type: 'enabled' } },
      cost_tracking: 'ignore_errors',
      ...(modelExtra ?? {}),
    },
  }
}

function boundedTail(value: string, limit = 2000): string {
  return value.length <= limit ? value : value.slice(-limit)
}

// The runner writes the one-row parquet with the same Python interpreter that
// runs the baseline. datasets.load_dataset(directory, split="test") infers the
// split from data/test-*.parquet.
export async function writeExternalDataset(input: { python: string; directory: string; row: Record<string, string> }): Promise<{ file: string; sha256: string }> {
  const dataDirectory = path.join(input.directory, 'data')
  await fs.mkdir(dataDirectory, { recursive: true })
  const file = path.join(dataDirectory, 'test-00000-of-00001.parquet')
  const script = [
    'import json, sys',
    'import pyarrow as pa',
    'import pyarrow.parquet as pq',
    'row = json.load(sys.stdin)',
    'pq.write_table(pa.Table.from_pylist([row]), sys.argv[1])',
  ].join('\n')
  const result = spawnSync(input.python, ['-c', script, file], { input: JSON.stringify(input.row), encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(`could not write the external dataset: ${boundedTail(result.stderr ?? '')}`)
  return { file, sha256: await sha256File(file) }
}

export async function probeExternalDataset(input: { python: string; directory: string; instanceId: string }): Promise<void> {
  const script = [
    'import sys',
    'from datasets import load_dataset',
    'data = load_dataset(sys.argv[1], split="test")',
    'assert len(data) == 1, len(data)',
    'assert data[0]["instance_id"] == sys.argv[2], data[0]["instance_id"]',
  ].join('\n')
  const result = spawnSync(input.python, ['-c', script, input.directory, input.instanceId], { encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(`external dataset load probe failed: ${boundedTail(result.stderr ?? '')}`)
}

export async function writeExternalConfig(file: string, config: Record<string, unknown>): Promise<{ sha256: string }> {
  const text = JSON.stringify(config, null, 2) + '\n'
  await fs.writeFile(file, text, { mode: 0o600 })
  return { sha256: sha256(text) }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function integer(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function usageFrom(value: unknown): Usage | undefined {
  const source = record(value)
  if (!source) return undefined
  const input = integer(source.prompt_tokens) ?? integer(source.input_tokens)
  const output = integer(source.completion_tokens) ?? integer(source.output_tokens)
  if (input === undefined || output === undefined) return undefined
  const total = integer(source.total_tokens)
  if (total !== undefined && total !== input + output) return undefined
  const details = record(source.prompt_tokens_details)
  const cached = integer(details?.cached_tokens) ?? integer(source.prompt_cache_hit_tokens) ?? integer(source.cache_read_input_tokens) ?? 0
  if (cached > input) return undefined
  const completionDetails = record(source.completion_tokens_details)
  const reasoning = integer(completionDetails?.reasoning_tokens)
  if (reasoning !== undefined && reasoning > output) return undefined
  // A cache-write price is not in the frozen snapshot; treat it as unknown rather than zero.
  if ((integer(source.cache_creation_input_tokens) ?? 0) > 0) return undefined
  return { inputTokens: input, outputTokens: output, totalTokens: input + output, source: 'provider', uncertain: false,
    cacheReadTokens: cached, ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}) }
}

export function readExternalUsage(trajectory: unknown): ExternalUsageReading {
  const root = record(trajectory)
  const messages = Array.isArray(root?.messages) ? root.messages : []
  const info = record(root?.info)
  const stats = record(info?.model_stats)
  const miniApiCalls = integer(stats?.api_calls) ?? null
  const reportedCostUsd = typeof stats?.instance_cost === 'number' && Number.isFinite(stats.instance_cost) ? stats.instance_cost : null
  const usage: Usage[] = []
  const reasons: string[] = []
  let toolCalls = 0
  let usageMessages = 0
  for (const [index, value] of messages.entries()) {
    const message = record(value)
    if (!message) continue
    const extra = record(message.extra)
    const actions = Array.isArray(extra?.actions) ? extra.actions.length : Array.isArray(message.tool_calls) ? message.tool_calls.length : 0
    toolCalls += actions
    const rawUsage = record(extra?.response)?.usage ?? extra?.usage
    if (rawUsage === undefined) continue
    usageMessages++
    const parsed = usageFrom(rawUsage)
    if (!parsed) {
      reasons.push(`message[${index}] has unreadable usage`)
      continue
    }
    usage.push(parsed)
  }
  if (!messages.length) reasons.push('trajectory has no messages')
  if (usage.length === 0) reasons.push('trajectory has no provider usage')
  if (miniApiCalls !== null && miniApiCalls !== usageMessages) reasons.push(`mini api_calls=${miniApiCalls} but ${usageMessages} messages carry usage`)
  const inputTokens = usage.reduce((sum, entry) => sum + entry.inputTokens, 0)
  const outputTokens = usage.reduce((sum, entry) => sum + entry.outputTokens, 0)
  const cacheReadTokens = usage.reduce((sum, entry) => sum + (entry.cacheReadTokens ?? 0), 0)
  return {
    usage, inputTokens, outputTokens, cacheReadTokens, modelRequests: miniApiCalls ?? usageMessages, toolCalls,
    miniApiCalls, reportedCostUsd, unknown: reasons.length > 0, reasons,
  }
}

export function externalCost(reading: ExternalUsageReading, prices: PriceSnapshot | null): { costUsd?: number; unknown: boolean; reason?: string } {
  if (reading.unknown) return { unknown: true, reason: reading.reasons[0] ?? 'unknown external usage' }
  if (!prices) return { unknown: true, reason: 'no price snapshot' }
  return usageCost(reading.usage, prices)
}

// The mini-DSH harness enforces a token cap derived from the per-task dollar
// cap. The external watchdog enforces the same cap so both arms face the same
// input+output allowance rather than the baseline's cheaper cache-read pricing.
export function externalBudgetExceeded(reading: ExternalUsageReading, caps: ExternalCaps,
  prices: PriceSnapshot | null): 'requests' | 'tool_calls' | 'token_budget' | 'cost' | null {
  if (reading.modelRequests >= caps.maxModelRequests) return 'requests'
  if (reading.toolCalls >= caps.maxToolCalls) return 'tool_calls'
  if (reading.inputTokens + reading.outputTokens >= caps.maxTotalTokens) return 'token_budget'
  const cost = externalCost(reading, prices)
  if (cost.costUsd !== undefined && cost.costUsd >= caps.maxCostUsd) return 'cost'
  return null
}

export async function readExternalPrediction(outputDirectory: string, instanceId: string): Promise<ExternalPredictionReading> {
  const file = path.join(outputDirectory, 'preds.json')
  const reasons: string[] = []
  let parsed: unknown
  try {
    parsed = JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (error) {
    return { path: file, reasons: [`cannot read preds.json: ${error instanceof Error ? error.message : String(error)}`] }
  }
  const root = record(parsed)
  if (!root) return { path: file, reasons: ['preds.json is not an object'] }
  const entry = record(root[instanceId])
  if (!entry) return { path: file, reasons: [`preds.json has no entry for ${instanceId}`] }
  if (entry.instance_id !== instanceId) reasons.push('preds.json entry instance_id does not match its key')
  const modelPatch = entry.model_patch
  if (modelPatch !== null && typeof modelPatch !== 'string') return { path: file, reasons: ['preds.json model_patch is not a string or null'] }
  const prediction: SwebenchPrediction = {
    instance_id: instanceId,
    model_name_or_path: typeof entry.model_name_or_path === 'string' ? entry.model_name_or_path : 'mini-swe-agent',
    model_patch: typeof modelPatch === 'string' ? modelPatch : '',
  }
  return { prediction, path: file, sha256: await sha256File(file), reasons }
}

export async function readExternalTrajectory(outputDirectory: string, instanceId: string): Promise<{ path: string; trajectory?: unknown; sha256?: string; reasons: string[] }> {
  const file = path.join(outputDirectory, instanceId, `${instanceId}.traj.json`)
  try {
    const text = await fs.readFile(file, 'utf8')
    return { path: file, trajectory: JSON.parse(text), sha256: sha256(text), reasons: [] }
  } catch (error) {
    return { path: file, reasons: [`cannot read trajectory: ${error instanceof Error ? error.message : String(error)}`] }
  }
}

export function externalExitStatus(trajectory: unknown): string | null {
  const info = record(record(trajectory)?.info)
  return typeof info?.exit_status === 'string' ? info.exit_status : null
}

// Exit codes are not sufficient: mini writes the exception class into
// exit_status and still exits 0. Presence of a usable trajectory/prediction is
// checked by the caller.
export function classifyExternalStatus(input: {
  miniExitStatus?: string | null
  exitCode?: number | null
  timedOut?: boolean
  killedBy?: 'wall_clock' | 'cost' | 'tool_calls' | 'requests' | 'token_budget' | 'cancelled' | null
}): EpisodeStatus {
  if (input.killedBy === 'cancelled') return 'cancelled'
  if (input.killedBy) return 'budget'
  if (input.timedOut) return 'timeout'
  const status = input.miniExitStatus ?? ''
  if (status === 'Submitted') return 'completed'
  if (status === 'LimitsExceeded') return 'budget'
  if (status === 'TimeExceeded' || status === 'TimeoutError') return 'timeout'
  if (/ContextWindow/i.test(status)) return 'budget'
  if (/KeyboardInterrupt|Cancelled/i.test(status)) return 'cancelled'
  if (/RepeatedFormatError/i.test(status)) return 'failed'
  if (/Authentication|Permission|NotFound|UnsupportedParams|ModelError/i.test(status)) return 'infrastructure'
  return 'infrastructure'
}

export function redactSecrets(value: string, secrets: readonly string[]): string {
  let result = value
  for (const secret of secrets) {
    if (secret.length < 8) continue
    result = result.split(secret).join('[REDACTED]')
  }
  return result
}

export function containsSecret(value: string, secrets: readonly string[]): boolean {
  return secrets.some(secret => secret.length >= 8 && value.includes(secret))
}

export async function readBounded(file: string, limit = 4 * 1024 * 1024): Promise<string> {
  const handle = await fs.open(file, 'r').catch(() => undefined)
  if (!handle) return ''
  try {
    const stat = await handle.stat()
    const size = Math.min(stat.size, limit)
    const buffer = Buffer.alloc(size)
    await handle.read(buffer, 0, size, 0)
    return buffer.toString('utf8')
  } finally {
    await handle.close()
  }
}

export function labelsFor(batchId: string, instanceId: string, armId: string, index: number): ExternalLabels {
  return externalLabels({ batchId, instanceId, armId, index })
}

export function isSha256(value: unknown): value is string {
  return typeof value === 'string' && hashPattern.test(value)
}
