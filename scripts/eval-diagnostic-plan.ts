import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createHarness } from '../src/app/create-harness.js'
import type { SessionEvent } from '../src/core/contracts.js'
import type { RunOutcome } from './eval-runner.js'
import { deriveV2Observation, developmentBatchStopReason } from './eval-v2-observation.js'
import { reliableSuccess } from './eval-v2-report.js'
import type { V2Observation } from './eval-v2-report.js'
import { resolveV2Arms, developmentReserveUsd } from './eval-v2-plan.js'
import { diagnosticValue } from './eval-diagnostic-fixture.js'

export const diagnosticProtocol = 'NX-51-BC01-log-2arm-v1' as const
export type DiagnosticArm = 'baseline' | 'full'
export interface DiagnosticEpisode { taskId: 'BC01'; bytes: 4096 | 262144; repeat: 0 | 1 | 2; arm: DiagnosticArm; block: number }
export interface DiagnosticPrice { source: string; capturedAt: string; currency: 'USD'; inputPerMillion: number; outputPerMillion: number; cacheReadPerMillion: number }
export interface DiagnosticConfig { model: 'deepseek/deepseek-flash'; echoedModel: 'deepseek-flash'; modelVersion: string; thinking: 'enabled'; sampling: 'provider-default'; baseUrl: string; priceSnapshot: DiagnosticPrice }
export interface FrozenFile { path: string; sha256: string }
export interface DiagnosticManifest extends DiagnosticConfig {
  protocol: typeof diagnosticProtocol; gitCommit: string; window: 1_000_000; scheduleSeed: 20261018
  episodes: DiagnosticEpisode[]; arms: ReturnType<typeof resolveV2Arms>; fixtureFiles: FrozenFile[]; sourceFiles: FrozenFile[]
  toolSchemaSha256: string; digest: string
}
export interface DiagnosticRecord {
  episode: DiagnosticEpisode; observation: V2Observation; diagnosticExecuted: boolean; diagnosticBeforeEdit: boolean
  diagnosticValueVisible: boolean; diagnosticReported: boolean
  reportedValue: string | null; readToolCalls: number; providerUsageMissing: number; localEstimatedInputTokens: number
  estimatedUsd: number; reliable: boolean; failureClass: string | null
}

const repository = fileURLToPath(new URL('../../', import.meta.url))
const fixtureRoot = path.join(repository, 'test/fixtures/harness-v2/BC01')
const sourcePaths = ['AGENTS.md', 'package.json', 'pnpm-lock.yaml', 'scripts/eval-diagnostic-fixture.ts', 'scripts/eval-diagnostic-plan.ts',
  'scripts/eval-diagnostic-run.ts', 'scripts/eval-fixture.ts', 'scripts/eval-v2-fixtures.ts', 'scripts/eval-v2-isolation.ts',
  'scripts/eval-v2-observation.ts', 'scripts/eval-v2-episode.ts', 'scripts/eval-v2-plan.ts', 'scripts/eval-v2-report.ts',
  'scripts/smoke-cost.ts', 'docs/context-budget/NX-51-DIAGNOSTIC.md']
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

export function diagnosticSchedule(): DiagnosticEpisode[] {
  const episodes: DiagnosticEpisode[] = []
  for (const repeat of [0, 1, 2] as const) for (const bytes of [4096, 262144] as const) {
    const block = repeat * 2 + (bytes === 4096 ? 0 : 1)
    // Three leads per arm overall, with both lead orders represented at each load.
    const arms: DiagnosticArm[] = [0, 3, 4].includes(block) ? ['baseline', 'full'] : ['full', 'baseline']
    for (const arm of arms) episodes.push({ taskId: 'BC01', bytes, repeat, arm, block })
  }
  return episodes
}

async function fileList(root: string, prefix = ''): Promise<FrozenFile[]> {
  const result: FrozenFile[] = []
  for (const entry of (await fs.readdir(path.join(root, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const name = path.posix.join(prefix, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`freeze refuses symlink: ${name}`)
    if (entry.isDirectory()) result.push(...await fileList(root, name))
    else if (entry.isFile()) result.push({ path: name, sha256: hash(await fs.readFile(path.join(root, name))) })
    else throw new Error(`freeze refuses non-file: ${name}`)
  }
  return result
}

async function sourceList(): Promise<FrozenFile[]> {
  return [...await Promise.all(sourcePaths.map(async name => ({ path: name, sha256: hash(await fs.readFile(path.join(repository, name))) }))),
    ...(await fileList(path.join(repository, 'src'))).map(file => ({ path: `src/${file.path}`, sha256: file.sha256 }))]
    .sort((a, b) => a.path.localeCompare(b.path, 'en'))
}

async function toolSchemaHash(): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'nx51-schema-'))
  const harness = await createHarness({ workspace, profile: 'coding' })
  try { return harness.capabilityManifest.toolSchemaSha256 }
  finally { await harness.dispose(); await fs.rm(workspace, { recursive: true, force: true }) }
}

export function validateDiagnosticConfig(config: DiagnosticConfig): void {
  if (config.model !== 'deepseek/deepseek-flash' || config.echoedModel !== 'deepseek-flash' || !config.modelVersion ||
    config.thinking !== 'enabled' || config.sampling !== 'provider-default' || config.baseUrl !== 'https://api.deepseek.com' ||
    config.priceSnapshot.source !== 'https://api-docs.deepseek.com/quick_start/pricing/' ||
    config.priceSnapshot.currency !== 'USD' || !Number.isFinite(Date.parse(config.priceSnapshot.capturedAt)) ||
    [config.priceSnapshot.inputPerMillion, config.priceSnapshot.outputPerMillion, config.priceSnapshot.cacheReadPerMillion]
      .some(value => !Number.isFinite(value) || value <= 0)) throw new Error('invalid NX-51 model or price snapshot')
}

export async function freezeDiagnostic(config: DiagnosticConfig, gitCommit: string): Promise<DiagnosticManifest> {
  validateDiagnosticConfig(config)
  if (!/^[a-f0-9]{40}$/.test(gitCommit)) throw new Error('freeze requires a clean Git commit')
  const fields = { protocol: diagnosticProtocol, gitCommit, window: 1_000_000 as const, scheduleSeed: 20261018 as const, ...config,
    episodes: diagnosticSchedule(), arms: resolveV2Arms(1_000_000, '1m').filter(arm => arm.name === 'baseline' || arm.name === 'full'),
    fixtureFiles: await fileList(fixtureRoot), sourceFiles: await sourceList(), toolSchemaSha256: await toolSchemaHash() }
  return { ...fields, digest: hash(JSON.stringify(fields)) }
}

export async function verifyDiagnosticManifest(manifest: DiagnosticManifest): Promise<void> {
  const { digest, ...fields } = manifest
  if (digest !== hash(JSON.stringify(fields)) || manifest.protocol !== diagnosticProtocol || manifest.window !== 1_000_000 ||
    manifest.scheduleSeed !== 20261018 || JSON.stringify(manifest.episodes) !== JSON.stringify(diagnosticSchedule()) ||
    JSON.stringify(manifest.arms) !== JSON.stringify(resolveV2Arms(1_000_000, '1m').filter(arm => arm.name === 'baseline' || arm.name === 'full')))
    throw new Error('NX-51 manifest digest, budget or schedule mismatch')
  validateDiagnosticConfig(manifest)
  if (JSON.stringify(await fileList(fixtureRoot)) !== JSON.stringify(manifest.fixtureFiles) ||
    JSON.stringify(await sourceList()) !== JSON.stringify(manifest.sourceFiles) ||
    await toolSchemaHash() !== manifest.toolSchemaSha256) throw new Error('NX-51 fixture, source or tool schema changed after freeze')
}

export function diagnosticReserve(price: DiagnosticPrice) {
  const perEpisode = developmentReserveUsd(price)
  return { ...perEpisode, batchUsd: perEpisode.perEpisodeUsd * 12 + perEpisode.probeUsd }
}

export function observeDiagnostic(episode: DiagnosticEpisode, outcome: RunOutcome, events: readonly SessionEvent[], evidenceComplete: boolean, localEstimatedInputTokens: number, price: DiagnosticPrice, requireProviderUsage = true): DiagnosticRecord {
  const observation = deriveV2Observation(episode, outcome, events, evidenceComplete)
  const callIds = new Set(events.flatMap(event => event.type === 'assistant/tool_calls' ? event.data.toolCalls.filter(call => call.name === 'bash' && call.arguments?.command === 'node diagnostic.mjs').map(call => call.id) : []))
  const diagnosticResult = events.find(event => event.type === 'tool/result' && callIds.has(event.data.toolCallId) && event.data.name === 'bash' && !event.data.isError)
  const diagnosticExecuted = !!diagnosticResult
  const firstEdit = events.find(event => event.type === 'tool/start' && ['edit_file', 'write_file'].includes(event.data.name))
  const diagnosticBeforeEdit = !!diagnosticResult && (!firstEdit || diagnosticResult.seq < firstEdit.seq)
  const diagnosticValueVisible = events.some(event => event.type === 'tool/result' && event.data.content.includes(`DIAGNOSTIC_VALUE=${diagnosticValue(episode.repeat)}`))
  const lastAnswer = events.filter(event => event.type === 'assistant/message').at(-1)
  const reportedValue = lastAnswer?.type === 'assistant/message' ? /DIAGNOSTIC_VALUE\s*[:=]\s*([a-f0-9]{20})/i.exec(lastAnswer.data.content)?.[1] ?? null : null
  const diagnosticReported = reportedValue === diagnosticValue(episode.repeat)
  const rejected = new Set(events.flatMap(event => event.type === 'model/rejected' ? [event.data.requestId] : []))
  const dispatched = events.flatMap(event => event.type === 'model/start' && !rejected.has(event.data.requestId) ? [event.data.requestId] : [])
  const providerIds = new Set(events.flatMap(event => event.type === 'model/usage' && event.data.usage.source === 'provider' ? [event.data.requestId] : []))
  const providerUsageMissing = dispatched.filter(id => !providerIds.has(id)).length
  const readToolCalls = events.filter(event => event.type === 'tool/start' && event.data.name === 'read_tool_result').length
  const metrics = observation.metrics
  const estimatedUsd = (Math.max(0, metrics.inputTokens - metrics.cacheReadTokens) * price.inputPerMillion +
    metrics.cacheReadTokens * price.cacheReadPerMillion + metrics.outputTokens * price.outputPerMillion) / 1_000_000
  const reliable = reliableSuccess(observation) && diagnosticExecuted && diagnosticBeforeEdit && diagnosticValueVisible && diagnosticReported && (!requireProviderUsage || providerUsageMissing === 0)
  const failureClass = reliable ? null : observation.failureReason === 'infrastructure' || observation.status === 'error' ? 'infrastructure' :
    observation.status !== 'completed' ? observation.status : !observation.evidenceComplete ? 'evidence' :
    requireProviderUsage && providerUsageMissing ? 'usage_missing' : !diagnosticExecuted ? 'diagnostic_not_run' :
    !diagnosticBeforeEdit ? 'diagnostic_after_edit' : !diagnosticValueVisible ? 'diagnostic_not_visible' :
    !diagnosticReported ? 'diagnostic_wrong_or_missing' : observation.accepted !== true ? 'business_acceptance' : 'other'
  return { episode, observation, diagnosticExecuted, diagnosticBeforeEdit, diagnosticValueVisible, diagnosticReported, reportedValue, readToolCalls, providerUsageMissing,
    localEstimatedInputTokens, estimatedUsd, reliable, failureClass }
}

export function diagnosticReport(manifest: DiagnosticManifest, records: readonly DiagnosticRecord[]) {
  const planned = manifest.episodes.map(episode => `${episode.bytes}/${episode.repeat}/${episode.arm}`)
  const seen = new Set<string>()
  for (const record of records) {
    const key = `${record.episode.bytes}/${record.episode.repeat}/${record.episode.arm}`
    if (!planned.includes(key) || seen.has(key) || JSON.stringify(manifest.episodes[records.indexOf(record)]) !== JSON.stringify(record.episode)) throw new Error('NX-51 unknown, duplicate or out-of-order observation')
    seen.add(key)
  }
  const missing = planned.filter(key => !seen.has(key))
  const sum = (rows: readonly DiagnosticRecord[], pick: (row: DiagnosticRecord) => number) => rows.reduce((total, row) => total + pick(row), 0)
  const groups = [4096, 262144].flatMap(bytes => (['baseline', 'full'] as const).map(arm => {
    const rows = records.filter(record => record.episode.bytes === bytes && record.episode.arm === arm)
    const failureClasses = Object.fromEntries([...new Set(rows.map(row => row.failureClass).filter((value): value is string => value !== null))]
      .map(reason => [reason, rows.filter(row => row.failureClass === reason).length]))
    const providerComplete = rows.every(row => row.providerUsageMissing === 0 && row.observation.metrics.estimatedTokens === 0)
    return { bytes, arm, planned: 3, executed: rows.length, reliable: rows.filter(row => row.reliable).length,
      failureClasses,
      artifactAccepted: rows.filter(row => row.observation.accepted === true).length, diagnosticExecuted: rows.filter(row => row.diagnosticExecuted).length,
      diagnosticBeforeEdit: rows.filter(row => row.diagnosticBeforeEdit).length, diagnosticValueVisible: rows.filter(row => row.diagnosticValueVisible).length,
      diagnosticReported: rows.filter(row => row.diagnosticReported).length,
      mainRequests: sum(rows, row => row.observation.metrics.mainRequests), summaryRequests: sum(rows, row => row.observation.metrics.summaryRequests),
      toolCalls: sum(rows, row => row.observation.metrics.toolCalls), readToolCalls: sum(rows, row => row.readToolCalls),
      toolErrors: sum(rows, row => row.observation.metrics.toolErrors), previewTruncations: sum(rows, row => row.observation.metrics.previewTruncations),
      providerInputTokens: providerComplete ? sum(rows, row => row.observation.metrics.inputTokens) : null,
      providerOutputTokens: providerComplete ? sum(rows, row => row.observation.metrics.outputTokens) : null,
      providerCacheReadTokens: providerComplete ? sum(rows, row => row.observation.metrics.cacheReadTokens) : null,
      summaryTokens: sum(rows, row => row.observation.metrics.summaryTokens),
      providerUsageMissing: sum(rows, row => row.providerUsageMissing), localEstimatedInputTokens: sum(rows, row => row.localEstimatedInputTokens),
      activeDurationMs: sum(rows, row => row.observation.metrics.activeDurationMs), knownUsageUsdEstimate: sum(rows, row => row.estimatedUsd),
      estimatedUsd: providerComplete ? sum(rows, row => row.estimatedUsd) : null }
  }))
  return { protocol: manifest.protocol, manifestDigest: manifest.digest, observationsDigest: hash(records.map(record => JSON.stringify(record)).join('\n')),
    planned: 12, executed: records.length, missing, incomplete: missing.length > 0 || records.some(record => record.observation.status === 'error' || record.providerUsageMissing > 0),
    groups, episodes: records, interpretation: 'development-only', measurementLimits: ['Three repeats are descriptive, not a significance or generalization test.',
      'Estimated USD uses provider token usage when complete; it is not a bill. Local ChatRequest estimates are separate.',
      'The composite Full configuration cannot isolate frozen-prefix or proactive-compaction effects.'] }
}

export function diagnosticStopReason(record: DiagnosticRecord, events: readonly SessionEvent[]): string | null {
  return developmentBatchStopReason(record.observation, events) ?? (record.providerUsageMissing ? 'usage_unknown' : null)
}
