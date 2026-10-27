import { componentLooProtocol } from './eval-v2-component-protocol.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { reliableSuccess, reportV2 } from './eval-v2-report.js'
import type { V2Manifest, V2Observation, V2Report } from './eval-v2-report.js'
import { componentLooVariants, repeatsForV2Split } from './eval-v2-plan.js'
import type { ComponentLooVariant } from './eval-v2-plan.js'

const PROTOCOL = 'NX-50-component-ab-v1' as const
const GATE_VERSION = 'nx50-component-gate-v1' as const
const TOLERANCE_EPISODES = 1
const MAX_RESOURCE_RATIO = 1.15
// NX-51 的 leave-one-out 比较器与 NX-50 的合并门槛分开：前者只作开发期描述性归因，
// 不产生 mergeEligible，也不把 5% 诊断阈值说成显著性。
const LOO_PROTOCOL = componentLooProtocol.id
const LOO_SPLIT = componentLooProtocol.split
const LOO_GATE_VERSION = componentLooProtocol.gateVersion
const LOO_THRESHOLD = componentLooProtocol.threshold
const LOO_VARIANTS = componentLooVariants
const LOO_NON_REFERENCE = LOO_VARIANTS.filter(variant => variant !== 'full')
// 相对 full 的**精确**源码差异。缺失预期文件说明回退没打全；多出任何 src 文件说明
// 两臂不只差这一项，归因就不成立。
export const looExpectedSourcePaths = componentLooProtocol.sourcePaths
const sha = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')
const stable = (value: unknown): string => JSON.stringify(value)
const parseTime = (value: unknown, name: string): number => {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error(`${name} is not a valid timestamp`)
  return Date.parse(value)
}

export interface V2BatchReport extends V2Report {
  startedAt?: string
  finishedAt?: string
  sourceBaseCommit?: string | null
  evaluationCommit?: string
  environment?: { node?: string; platform?: string; release?: string; isolation?: string }
  spentUsdEstimate?: number
  stopped?: boolean
  stopReason?: string
}
export interface V2BatchEvidence {
  evidenceRoot: string
  manifest: V2Manifest
  observations: readonly V2Observation[]
  report: V2BatchReport
  packageJson: Record<string, unknown>
  packageSha256: string
}
interface GateSideMetrics {
  planned: number
  executed: number
  reliableSuccesses: number
  artifactAccepted: number
  tokens: number
  providerTokens: number
  estimatedTokens: number
  cacheReadTokens: number
  activeDurationMs: number
  requests: number
  tools: number
  toolErrors: number
  toolSkipped: number
  pressureCompactions: number
  previewTruncations: number
  timeouts: number
}
interface GateTaskPair {
  taskId: string
  family: string
  shape: string
  old: { repeat: number; reliableSuccess: boolean; artifactAccepted: boolean; status: string }[]
  new: { repeat: number; reliableSuccess: boolean; artifactAccepted: boolean; status: string }[]
  oldTokens: number
  newTokens: number
  oldActiveMs: number
  newActiveMs: number
  reliableRegression: boolean
  artifactRegression: boolean
  reviewRequired: boolean
}

export async function readV2BatchEvidence(evidenceRoot: string): Promise<V2BatchEvidence> {
  const root = path.resolve(evidenceRoot)
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8')) as V2Manifest
  const observations = (await fs.readFile(path.join(root, 'runs.jsonl'), 'utf8')).split(/\r?\n/).filter(Boolean)
    .map(line => JSON.parse(line) as V2Observation)
  const stored = JSON.parse(await fs.readFile(path.join(root, 'report.json'), 'utf8')) as V2BatchReport
  const recomputed = reportV2(manifest, observations)
  for (const field of ['manifestDigest', 'observationsDigest', 'planned', 'executed', 'incomplete'] as const) {
    if (stable(stored[field]) !== stable(recomputed[field])) throw new Error(`stored report is stale or tampered: ${field}`)
  }
  if (stable(stored.missing) !== stable(recomputed.missing) || stable(stored.invalid) !== stable(recomputed.invalid)) {
    throw new Error('stored report is stale or tampered: missing/invalid')
  }
  if (stored.stopped !== false) throw new Error('batch stopped before completing its fixed plan')
  if (stored.evaluationCommit !== manifest.gitCommit) throw new Error('batch evaluation commit does not match manifest')
  if ((stored.sourceBaseCommit ?? null) !== (manifest.sourceBaseCommit ?? null)) throw new Error('batch source base commit does not match manifest')
  parseTime(stored.startedAt, 'startedAt')
  parseTime(stored.finishedAt, 'finishedAt')
  if (Date.parse(stored.finishedAt!) < Date.parse(stored.startedAt!)) throw new Error('batch finished before it started')
  const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')) as Record<string, unknown>
  const packageSha256 = sha(await fs.readFile(path.join(root, 'package.json')))
  const frozenPackage = manifest.sourceFiles.find(file => file.path === 'package.json')
  if (!frozenPackage || frozenPackage.sha256 !== packageSha256) throw new Error('batch package.json does not match the frozen source list')
  return { evidenceRoot: root, manifest, observations, report: stored, packageJson, packageSha256 }
}

function sourceDifferences(oldBatch: V2BatchEvidence, newBatch: V2BatchEvidence) {
  const oldFiles = new Map(oldBatch.manifest.sourceFiles.map(file => [file.path, file.sha256]))
  const newFiles = new Map(newBatch.manifest.sourceFiles.map(file => [file.path, file.sha256]))
  const allowed: { path: string; reason: string }[] = []
  const rejected: { path: string; reason: string }[] = []
  for (const file of [...new Set([...oldFiles.keys(), ...newFiles.keys()])].sort()) {
    if (oldFiles.get(file) === newFiles.get(file)) continue
    if (file.startsWith('src/')) allowed.push({ path: file, reason: 'product-source' })
    else if (file === 'package.json') allowed.push({ path: file, reason: 'package-script' })
    else rejected.push({ path: file, reason: 'unexpected-source-difference' })
  }
  if (!allowed.some(file => file.reason === 'product-source')) rejected.push({ path: 'src/**', reason: 'no-product-source-difference' })
  return { allowed, rejected }
}

function packageDifference(oldPackage: Record<string, unknown>, newPackage: Record<string, unknown>): string | null {
  const { scripts: oldScriptsRaw, ...oldRest } = oldPackage
  const { scripts: newScriptsRaw, ...newRest } = newPackage
  if (stable(oldRest) !== stable(newRest)) return 'non-script package fields differ'
  const oldScripts = (oldScriptsRaw ?? {}) as Record<string, unknown>
  const newScripts = (newScriptsRaw ?? {}) as Record<string, unknown>
  for (const key of new Set([...Object.keys(oldScripts), ...Object.keys(newScripts)])) {
    if (key === 'bench:components') {
      if (oldScripts[key] !== undefined || newScripts[key] === undefined) return 'bench:components must be added only in the optimized checkout'
      continue
    }
    if (stable(oldScripts[key]) !== stable(newScripts[key])) return `script differs: ${key}`
  }
  return null
}

function sideMetrics(batch: V2BatchEvidence): GateSideMetrics {
  const rows = batch.observations
  const sum = (field: keyof V2Observation['metrics']): number => rows.reduce((total, row) => {
    const value = row.metrics[field]
    return total + (typeof value === 'number' ? value : 0)
  }, 0)
  return {
    planned: batch.report.planned,
    executed: batch.report.executed,
    reliableSuccesses: rows.filter(reliableSuccess).length,
    artifactAccepted: rows.filter(row => row.accepted === true).length,
    tokens: rows.reduce((total, row) => total + row.metrics.inputTokens + row.metrics.outputTokens, 0),
    providerTokens: sum('providerTokens'),
    estimatedTokens: sum('estimatedTokens'),
    cacheReadTokens: sum('cacheReadTokens'),
    activeDurationMs: sum('activeDurationMs'),
    requests: rows.reduce((total, row) => total + row.metrics.mainRequests + row.metrics.summaryRequests, 0),
    tools: sum('toolCalls'),
    toolErrors: sum('toolErrors'),
    toolSkipped: sum('toolSkipped'),
    pressureCompactions: sum('pressureCompactions'),
    previewTruncations: sum('previewTruncations'),
    timeouts: sum('timeouts'),
  }
}

function requireProviderCoverage(batch: V2BatchEvidence, metrics: GateSideMetrics): void {
  if (metrics.estimatedTokens !== 0 || metrics.providerTokens <= 0 || !batch.observations.every(row => row.metrics.providerTokens > 0)) {
    throw new Error('provider usage coverage is incomplete; estimated usage cannot be treated as zero cost')
  }
}

function assertComparable(oldBatch: V2BatchEvidence, newBatch: V2BatchEvidence): void {
  const oldManifest = oldBatch.manifest, newManifest = newBatch.manifest
  const fail = (message: string): never => { throw new Error(`batches are not comparable: ${message}`) }
  if (oldManifest.protocol !== PROTOCOL || newManifest.protocol !== PROTOCOL) fail('protocol')
  if (oldManifest.split !== 'component' || newManifest.split !== 'component') fail('split')
  if (stable(oldManifest.tasks) !== stable(newManifest.tasks)) fail('task contracts or fixture hashes')
  if (stable(oldManifest.episodes) !== stable(newManifest.episodes)) fail('episode schedule')
  if (stable(oldManifest.arms) !== stable(newManifest.arms) || oldManifest.arms.length !== 1 || oldManifest.arms[0]!.name !== 'context') fail('single context arm')
  if (oldManifest.scheduleSeed !== newManifest.scheduleSeed || oldManifest.scheduleSeed !== 20261025) fail('schedule seed')
  if (oldManifest.tier !== '1m' || newManifest.tier !== '1m') fail('tier')
  if (oldManifest.window !== 1_000_000 || newManifest.window !== 1_000_000) fail('window')
  for (const field of ['model', 'echoedModel', 'modelVersion', 'thinking', 'sampling', 'baseUrl'] as const) {
    if (oldManifest[field] !== newManifest[field]) fail(field)
  }
  if (stable(oldManifest.priceSnapshot) !== stable(newManifest.priceSnapshot)) fail('price snapshot')
  if (!oldManifest.toolSchemaSha256 || oldManifest.toolSchemaSha256 !== newManifest.toolSchemaSha256) fail('tool schema')
  const oldBase = oldManifest.sourceBaseCommit, newBase = newManifest.sourceBaseCommit
  if (!oldBase || !newBase || !/^[0-9a-f]{40}$/.test(oldBase) || !/^[0-9a-f]{40}$/.test(newBase) || oldBase === newBase) fail('source base commits')
  if (oldManifest.gitCommit === newManifest.gitCommit) fail('evaluation commits')
  for (const batch of [oldBatch, newBatch]) {
    if (batch.report.incomplete || batch.report.missing.length || batch.report.invalid.length) fail('incomplete batch')
    if (batch.report.planned !== 12 || batch.report.executed !== 12) fail('fixed denominator')
    if (batch.report.stopped !== false) fail('stopped batch')
    if (!batch.report.environment || stable(batch.report.environment.node) !== stable(oldBatch.report.environment?.node) ||
      batch.report.environment.platform !== oldBatch.report.environment?.platform || batch.report.environment.isolation !== oldBatch.report.environment?.isolation) fail('environment')
  }
  const newFinished = parseTime(newBatch.report.finishedAt, 'new finishedAt')
  const oldStarted = parseTime(oldBatch.report.startedAt, 'old startedAt')
  if (newFinished > oldStarted) fail('pre-registered new-first batch order was not respected')
  const differences = sourceDifferences(oldBatch, newBatch)
  if (differences.rejected.length) fail('source differences outside src/** and package.json')
  const packageReason = packageDifference(oldBatch.packageJson, newBatch.packageJson)
  if (packageReason) fail(packageReason)
}

function taskPairs(oldBatch: V2BatchEvidence, newBatch: V2BatchEvidence): GateTaskPair[] {
  const repeats = repeatsForV2Split('component')
  return oldBatch.manifest.tasks.map(task => {
    const rows = (batch: V2BatchEvidence) => batch.observations.filter(row => row.taskId === task.id).sort((a, b) => a.repeat - b.repeat)
    const oldRows = rows(oldBatch), newRows = rows(newBatch)
    if (oldRows.length !== repeats || newRows.length !== repeats) throw new Error(`task pairing is incomplete: ${task.id}`)
    const summarize = (row: V2Observation) => ({ repeat: row.repeat, reliableSuccess: reliableSuccess(row), artifactAccepted: row.accepted === true, status: row.status })
    const oldSummary = oldRows.map(summarize), newSummary = newRows.map(summarize)
    const oldReliable = oldSummary.filter(row => row.reliableSuccess).length === repeats
    const oldArtifact = oldSummary.filter(row => row.artifactAccepted).length === repeats
    const reliableRegression = oldReliable && newSummary.every(row => !row.reliableSuccess)
    const artifactRegression = oldArtifact && newSummary.every(row => !row.artifactAccepted)
    return {
      taskId: task.id, family: task.family, shape: task.shape, old: oldSummary, new: newSummary,
      oldTokens: oldRows.reduce((total, row) => total + row.metrics.inputTokens + row.metrics.outputTokens, 0),
      newTokens: newRows.reduce((total, row) => total + row.metrics.inputTokens + row.metrics.outputTokens, 0),
      oldActiveMs: oldRows.reduce((total, row) => total + row.metrics.activeDurationMs, 0),
      newActiveMs: newRows.reduce((total, row) => total + row.metrics.activeDurationMs, 0),
      reliableRegression, artifactRegression, reviewRequired: reliableRegression || artifactRegression,
    }
  })
}

export function compareV2Batches(oldBatch: V2BatchEvidence, newBatch: V2BatchEvidence) {
  assertComparable(oldBatch, newBatch)
  const oldMetrics = sideMetrics(oldBatch), newMetrics = sideMetrics(newBatch)
  requireProviderCoverage(oldBatch, oldMetrics)
  requireProviderCoverage(newBatch, newMetrics)
  const differences = sourceDifferences(oldBatch, newBatch)
  const packageReason = packageDifference(oldBatch.packageJson, newBatch.packageJson)
  const pairs = taskPairs(oldBatch, newBatch)
  const reliablePass = newMetrics.reliableSuccesses >= oldMetrics.reliableSuccesses - TOLERANCE_EPISODES
  const artifactPass = newMetrics.artifactAccepted >= oldMetrics.artifactAccepted - TOLERANCE_EPISODES
  const tokenPass = oldMetrics.tokens === 0 ? newMetrics.tokens === 0 : newMetrics.tokens <= oldMetrics.tokens * MAX_RESOURCE_RATIO + 1e-9
  const activePass = oldMetrics.activeDurationMs === 0 ? newMetrics.activeDurationMs === 0 : newMetrics.activeDurationMs <= oldMetrics.activeDurationMs * MAX_RESOURCE_RATIO + 1e-9
  const reviewRequired = pairs.some(pair => pair.reviewRequired)
  const reasons: string[] = []
  if (!reliablePass) reasons.push('reliable-completion-below-tolerance')
  if (!artifactPass) reasons.push('artifact-acceptance-below-tolerance')
  if (!tokenPass) reasons.push('token-consumption-above-limit')
  if (!activePass) reasons.push('active-time-above-limit')
  if (reviewRequired) reasons.push('task-double-regression-needs-trace-review')
  const status = !reliablePass || !artifactPass || !tokenPass || !activePass ? 'fail' : reviewRequired ? 'review-required' : 'pass'
  return {
    protocol: PROTOCOL, gateVersion: GATE_VERSION, createdAt: new Date().toISOString(),
    old: {
      sourceBaseCommit: oldBatch.manifest.sourceBaseCommit, evaluationCommit: oldBatch.manifest.gitCommit,
      manifestDigest: oldBatch.manifest.digest, observationsDigest: oldBatch.report.observationsDigest,
      startedAt: oldBatch.report.startedAt, finishedAt: oldBatch.report.finishedAt,
      spentUsdEstimate: oldBatch.report.spentUsdEstimate ?? null, metrics: oldMetrics,
    },
    new: {
      sourceBaseCommit: newBatch.manifest.sourceBaseCommit, evaluationCommit: newBatch.manifest.gitCommit,
      manifestDigest: newBatch.manifest.digest, observationsDigest: newBatch.report.observationsDigest,
      startedAt: newBatch.report.startedAt, finishedAt: newBatch.report.finishedAt,
      spentUsdEstimate: newBatch.report.spentUsdEstimate ?? null, metrics: newMetrics,
    },
    checks: {
      protocol: true, tasks: true, episodes: true, arms: true, seed: true, tierWindow: true, model: true,
      priceSnapshot: true, toolSchema: true, sourceFiles: differences.rejected.length === 0,
      packageJson: packageReason === null, complete: true, batchProvenance: true, batchOrder: true,
    },
    sourceDifferences: differences,
    reliableCompletion: {
      old: oldMetrics.reliableSuccesses, new: newMetrics.reliableSuccesses,
      deltaEpisodes: newMetrics.reliableSuccesses - oldMetrics.reliableSuccesses,
      toleranceEpisodes: TOLERANCE_EPISODES, pass: reliablePass,
    },
    artifactAcceptance: {
      old: oldMetrics.artifactAccepted, new: newMetrics.artifactAccepted,
      deltaEpisodes: newMetrics.artifactAccepted - oldMetrics.artifactAccepted,
      toleranceEpisodes: TOLERANCE_EPISODES, pass: artifactPass,
    },
    tokens: {
      old: oldMetrics.tokens, new: newMetrics.tokens,
      ratio: oldMetrics.tokens === 0 ? (newMetrics.tokens === 0 ? 1 : null) : newMetrics.tokens / oldMetrics.tokens,
      limit: MAX_RESOURCE_RATIO, pass: tokenPass,
    },
    activeTime: {
      oldMs: oldMetrics.activeDurationMs, newMs: newMetrics.activeDurationMs,
      ratio: oldMetrics.activeDurationMs === 0 ? (newMetrics.activeDurationMs === 0 ? 1 : null) : newMetrics.activeDurationMs / oldMetrics.activeDurationMs,
      limit: MAX_RESOURCE_RATIO, pass: activePass,
    },
    tasks: pairs,
    gate: { status, mergeEligible: status === 'pass', reasons },
    interpretation: 'development-only',
    significanceClaim: false,
    measurementLimits: [
      'Six tasks x two repeats per version; this is a development gate, not a significance test or a generalization claim.',
      'The two batches ran sequentially and provider prompt cache may be shared; timestamps are reported and no causal latency claim is made.',
      'Token totals are input + output from provider usage; cache-hit savings are reported separately and are not treated as total-token reductions.',
    ],
  }
}

// ── NX-51 四臂 leave-one-out 比较 ───────────────────────────────────────────────
// 四份证据来自四个源码提交，每份仍是一条 `context` 臂。这里只做**描述性**归因：
// `full` 是参照，三个 `no-X` 各回答“去掉这一项之后，付费读数与离线机制读数怎么变”。
// 5% 是诊断阈值，不是显著性；任何 `signal` 都要求付费资源变差与离线机制变差**同时**成立。

export interface V2OfflineProbeEvidence {
  file: string
  sha256: string
  protocol: 'mini-dsh-components-v1'
  evidenceKind: 'offline-mechanism'
  sourceCommit: string
  suiteSha256: string
  providerRequests: 0
  moduleSha256: Record<string, string>
  tools: { id: string; limit: number; originalBytes: number; visibleBytes: number; withinLimit: boolean; tailVisible: boolean; fullRecall: boolean }[]
  compaction: { id: string; events: number; propertyReads: number; outputSha256: string; correct: boolean; medianMs: number }[]
  reports: { id: string; checks: number; uniqueFiles: number; snapshotOpens: number; correct: boolean; outputSha256: string }[]
}

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const isHex = (value: unknown, length: number): value is string => typeof value === 'string' && new RegExp(`^[0-9a-f]{${length}}$`).test(value)

function probeObject(probe: V2OfflineProbeEvidence): V2OfflineProbeEvidence {
  if (probe.protocol !== 'mini-dsh-components-v1' || probe.evidenceKind !== 'offline-mechanism') throw new Error('offline probe protocol or evidence kind mismatch')
  if (!isHex(probe.sourceCommit, 40) || !isHex(probe.suiteSha256, 64) || !isHex(probe.sha256, 64)) throw new Error('offline probe source/suite/file hash is invalid')
  if (probe.providerRequests !== 0) throw new Error('offline probe must record zero provider requests')
  if (!Array.isArray(probe.tools) || !Array.isArray(probe.compaction) || !Array.isArray(probe.reports)) throw new Error('offline probe is missing a case family')
  if (!probe.tools.length || !probe.compaction.length || !probe.reports.length) throw new Error('offline probe contains an empty case family')
  for (const item of probe.tools) if (typeof item.id !== 'string' || !isFiniteNumber(item.limit) || !isFiniteNumber(item.originalBytes) || !isFiniteNumber(item.visibleBytes) ||
    typeof item.withinLimit !== 'boolean' || typeof item.tailVisible !== 'boolean' || typeof item.fullRecall !== 'boolean') throw new Error(`invalid offline tool case: ${String(item.id)}`)
  for (const item of probe.compaction) if (typeof item.id !== 'string' || !isFiniteNumber(item.events) || !isFiniteNumber(item.propertyReads) || !isFiniteNumber(item.medianMs) ||
    typeof item.correct !== 'boolean' || !isHex(item.outputSha256, 64)) throw new Error(`invalid offline compaction case: ${String(item.id)}`)
  for (const item of probe.reports) if (typeof item.id !== 'string' || !isFiniteNumber(item.checks) || !isFiniteNumber(item.uniqueFiles) || !isFiniteNumber(item.snapshotOpens) ||
    typeof item.correct !== 'boolean' || !isHex(item.outputSha256, 64)) throw new Error(`invalid offline report case: ${String(item.id)}`)
  if (new Set(probe.tools.map(item => item.id)).size !== probe.tools.length || new Set(probe.compaction.map(item => item.id)).size !== probe.compaction.length ||
    new Set(probe.reports.map(item => item.id)).size !== probe.reports.length) throw new Error('offline probe contains duplicate case ids')
  return probe
}

export async function readV2OfflineProbe(file: string): Promise<V2OfflineProbeEvidence> {
  const resolved = path.resolve(file)
  const raw = await fs.readFile(resolved)
  let value: unknown
  try { value = JSON.parse(raw.toString('utf8')) } catch { throw new Error(`offline probe is not JSON: ${file}`) }
  if (value === null || typeof value !== 'object') throw new Error(`offline probe is not an object: ${file}`)
  return probeObject({ ...(value as V2OfflineProbeEvidence), file: resolved, sha256: sha(raw) })
}

export interface LooMetrics {
  planned: number
  executed: number
  reliableSuccesses: number
  artifactAccepted: number
  tokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  providerTokens: number
  estimatedTokens: number
  activeDurationMs: number
  modelActiveDurationMs: number
  nonModelActiveDurationMs: number
  requests: number
  summaryRequests: number
  summaryDurationMs: number
  toolCalls: number
  toolErrors: number
  previewTruncations: number
  pressureCompactions: number
  timeouts: number
}

const looSum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0)
const looNonModel = (row: V2Observation): number => Math.max(0, row.metrics.activeDurationMs - looSum(row.metrics.requestDurationsMs))
function looMetrics(batch: V2BatchEvidence): LooMetrics {
  const rows = batch.observations
  const sum = (field: keyof V2Observation['metrics']): number => rows.reduce((total, row) => {
    const value = row.metrics[field]
    return total + (typeof value === 'number' ? value : 0)
  }, 0)
  return {
    planned: batch.report.planned, executed: batch.report.executed,
    reliableSuccesses: rows.filter(reliableSuccess).length,
    artifactAccepted: rows.filter(row => row.accepted === true).length,
    tokens: rows.reduce((total, row) => total + row.metrics.inputTokens + row.metrics.outputTokens, 0),
    inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), cacheReadTokens: sum('cacheReadTokens'),
    providerTokens: sum('providerTokens'), estimatedTokens: sum('estimatedTokens'),
    activeDurationMs: sum('activeDurationMs'),
    modelActiveDurationMs: rows.reduce((total, row) => total + looSum(row.metrics.requestDurationsMs), 0),
    nonModelActiveDurationMs: rows.reduce((total, row) => total + looNonModel(row), 0),
    requests: rows.reduce((total, row) => total + row.metrics.mainRequests + row.metrics.summaryRequests, 0),
    summaryRequests: sum('summaryRequests'), summaryDurationMs: sum('summaryDurationMs'),
    toolCalls: sum('toolCalls'), toolErrors: sum('toolErrors'), previewTruncations: sum('previewTruncations'),
    pressureCompactions: sum('pressureCompactions'), timeouts: sum('timeouts'),
  }
}

export interface LooRepeatReading {
  repeat: number
  reliableSuccess: boolean
  artifactAccepted: boolean
  status: string
  tokens: number
  outputTokens: number
  activeDurationMs: number
  nonModelActiveDurationMs: number
  summaryRequests: number
}
export interface LooTaskPair {
  taskId: string
  family: string
  shape: string
  reference: LooRepeatReading[]
  variant: LooRepeatReading[]
  fullMinusVariant: { tokens: number; outputTokens: number; activeDurationMs: number; nonModelActiveDurationMs: number; reliableSuccesses: number; artifactAccepted: number }
}

const looReading = (row: V2Observation): LooRepeatReading => ({
  repeat: row.repeat, reliableSuccess: reliableSuccess(row), artifactAccepted: row.accepted === true, status: row.status,
  tokens: row.metrics.inputTokens + row.metrics.outputTokens, outputTokens: row.metrics.outputTokens,
  activeDurationMs: row.metrics.activeDurationMs, nonModelActiveDurationMs: looNonModel(row), summaryRequests: row.metrics.summaryRequests,
})

function looTaskPairs(reference: V2BatchEvidence, variant: V2BatchEvidence): LooTaskPair[] {
  const repeats = repeatsForV2Split(LOO_SPLIT)
  return reference.manifest.tasks.map(task => {
    const pick = (batch: V2BatchEvidence) => batch.observations.filter(row => row.taskId === task.id).sort((a, b) => a.repeat - b.repeat).map(looReading)
    const left = pick(reference), right = pick(variant)
    if (left.length !== repeats || right.length !== repeats) throw new Error(`LOO task pairing is incomplete: ${task.id}`)
    const total = (rows: readonly LooRepeatReading[], field: keyof Pick<LooRepeatReading, 'tokens' | 'outputTokens' | 'activeDurationMs' | 'nonModelActiveDurationMs'>) => rows.reduce((sum, row) => sum + row[field], 0)
    return {
      taskId: task.id, family: task.family, shape: task.shape, reference: left, variant: right,
      fullMinusVariant: {
        tokens: total(left, 'tokens') - total(right, 'tokens'), outputTokens: total(left, 'outputTokens') - total(right, 'outputTokens'),
        activeDurationMs: total(left, 'activeDurationMs') - total(right, 'activeDurationMs'),
        nonModelActiveDurationMs: total(left, 'nonModelActiveDurationMs') - total(right, 'nonModelActiveDurationMs'),
        reliableSuccesses: left.filter(row => row.reliableSuccess).length - right.filter(row => row.reliableSuccess).length,
        artifactAccepted: left.filter(row => row.artifactAccepted).length - right.filter(row => row.artifactAccepted).length,
      },
    }
  })
}

export interface LooProbes {
  reference: V2OfflineProbeEvidence
  variants: Partial<Record<ComponentLooVariant, V2OfflineProbeEvidence>>
}
export interface LooCompareOptions {
  probes?: LooProbes
  expectedSourceBaseCommits?: Partial<Record<ComponentLooVariant, string>>
}

export interface LooDelta { reference: number; variant: number; fullMinusVariant: number; percentVsFull: number | null; worseWhenRemoved: boolean; betterWhenRemoved: boolean }
const looDelta = (reference: number, variant: number): LooDelta => {
  const percent = reference === 0 ? (variant === 0 ? 0 : null) : (variant - reference) / reference
  return {
    reference, variant, fullMinusVariant: reference - variant, percentVsFull: percent,
    worseWhenRemoved: percent === null ? reference === 0 && variant > 0 : percent >= LOO_THRESHOLD,
    betterWhenRemoved: percent === null ? false : percent <= -LOO_THRESHOLD,
  }
}

function sourceChanges(reference: V2BatchEvidence, variant: V2BatchEvidence) {
  const left = new Map(reference.manifest.sourceFiles.map(file => [file.path, file.sha256]))
  const right = new Map(variant.manifest.sourceFiles.map(file => [file.path, file.sha256]))
  return [...new Set([...left.keys(), ...right.keys()])].filter(file => left.get(file) !== right.get(file)).sort()
}

type LooDistribution = Record<string, { reference: number; variant: number; percentVsFull: number | null }>
function perRepeat(batch: V2BatchEvidence, repeat: number, select: (row: V2Observation) => number): number {
  return batch.observations.filter(row => row.repeat === repeat).reduce((total, row) => total + select(row), 0)
}
function repeatDistribution(reference: V2BatchEvidence, variant: V2BatchEvidence, select: (row: V2Observation) => number): LooDistribution {
  return Object.fromEntries(Array.from({ length: repeatsForV2Split(LOO_SPLIT) }, (_, repeat) => {
    const left = perRepeat(reference, repeat, select), right = perRepeat(variant, repeat, select)
    return [String(repeat), { reference: left, variant: right, percentVsFull: left === 0 ? (right === 0 ? 0 : null) : (right - left) / left }]
  }))
}
const signConsistent = (values: readonly number[]): boolean => !(values.some(value => value > 0) && values.some(value => value < 0))

function probeReadings(reference: V2OfflineProbeEvidence, variant: V2OfflineProbeEvidence) {
  const passed = (probe: V2OfflineProbeEvidence) => probe.tools.filter(item => item.withinLimit && item.tailVisible && item.fullRecall).length
  const recall = (probe: V2OfflineProbeEvidence) => probe.tools.filter(item => item.fullRecall).length
  return {
    suiteSha256: reference.suiteSha256,
    tools: {
      cases: reference.tools.length, referencePassed: passed(reference), variantPassed: passed(variant),
      referenceFullRecall: recall(reference), variantFullRecall: recall(variant),
      variantVisibleBytes: variant.tools.reduce((sum, item) => sum + item.visibleBytes, 0),
      variantOriginalBytes: variant.tools.reduce((sum, item) => sum + item.originalBytes, 0),
    },
    compaction: {
      cases: reference.compaction.length,
      referencePropertyReads: reference.compaction.reduce((sum, item) => sum + item.propertyReads, 0),
      variantPropertyReads: variant.compaction.reduce((sum, item) => sum + item.propertyReads, 0),
      referenceMedianMs: reference.compaction.reduce((sum, item) => sum + item.medianMs, 0),
      variantMedianMs: variant.compaction.reduce((sum, item) => sum + item.medianMs, 0),
      outputHashesMatch: reference.compaction.every((item, index) => item.outputSha256 === variant.compaction[index]?.outputSha256),
    },
    reports: {
      cases: reference.reports.length,
      referenceSnapshotOpens: reference.reports.reduce((sum, item) => sum + item.snapshotOpens, 0),
      variantSnapshotOpens: variant.reports.reduce((sum, item) => sum + item.snapshotOpens, 0),
      outputHashesMatch: reference.reports.every((item, index) => item.outputSha256 === variant.reports[index]?.outputSha256),
    },
  }
}

function assertLooProbes(reference: V2BatchEvidence, variants: Record<Exclude<ComponentLooVariant, 'full'>, V2BatchEvidence>, probes?: LooProbes) {
  if (probes === undefined) return undefined
  const script = reference.manifest.sourceFiles.find(file => file.path === 'scripts/benchmark-components.mjs')
  if (!script) throw new Error('LOO reference manifest does not freeze scripts/benchmark-components.mjs')
  const all: [ComponentLooVariant, V2OfflineProbeEvidence][] = [['full', probeObject(probes.reference)]]
  for (const label of LOO_NON_REFERENCE) {
    const probe = probes.variants[label]
    if (!probe) throw new Error(`offline probe missing for ${label}`)
    all.push([label, probeObject(probe)])
  }
  for (const [label, probe] of all) {
    if (probe.suiteSha256 !== script.sha256) throw new Error(`offline probe suite hash does not match the frozen benchmark script: ${label}`)
    if (probe.sourceCommit !== (label === 'full' ? reference.manifest.sourceBaseCommit : variants[label].manifest.sourceBaseCommit)) {
      throw new Error(`offline probe source commit does not match the manifest: ${label}`)
    }
  }
  const left = all[0]![1]
  for (const [label, probe] of all.slice(1)) {
    if (probe.suiteSha256 !== left.suiteSha256) throw new Error('offline probes do not share one frozen suite')
    if (stable(probe.tools.map(item => item.id)) !== stable(left.tools.map(item => item.id)) ||
      stable(probe.compaction.map(item => item.id)) !== stable(left.compaction.map(item => item.id)) ||
      stable(probe.reports.map(item => item.id)) !== stable(left.reports.map(item => item.id))) throw new Error(`offline probe case ids differ: ${label}`)
    if (probe.tools.some(item => !item.fullRecall)) throw new Error(`offline probe lost full recall: ${label}`)
    if (probe.compaction.some(item => !item.correct) || probe.reports.some(item => !item.correct)) throw new Error(`offline probe evidence changed: ${label}`)
    for (const item of probe.compaction) {
      const baseline = left.compaction.find(candidate => candidate.id === item.id)
      if (!baseline || baseline.outputSha256 !== item.outputSha256) throw new Error(`offline compaction output changed: ${label}/${item.id}`)
    }
    for (const item of probe.reports) {
      const baseline = left.reports.find(candidate => candidate.id === item.id)
      if (!baseline || baseline.outputSha256 !== item.outputSha256) throw new Error(`offline report output changed: ${label}/${item.id}`)
    }
  }
  return all
}

function mechanismStatus(label: ComponentLooVariant, reference: V2OfflineProbeEvidence | undefined, variant: V2OfflineProbeEvidence | undefined): 'reference' | 'confirmed-adverse' | 'confirmed-benefit' | 'not-confirmed' | 'not-measured' {
  if (label === 'full') return 'reference'
  if (!reference || !variant) return 'not-measured'
  const readings = probeReadings(reference, variant)
  if (label === 'no-preview') {
    if (readings.tools.variantPassed < readings.tools.referencePassed) return 'confirmed-adverse'
    if (readings.tools.variantPassed > readings.tools.referencePassed) return 'confirmed-benefit'
    return 'not-confirmed'
  }
  if (label === 'no-projection') {
    if (readings.compaction.variantPropertyReads > readings.compaction.referencePropertyReads) return 'confirmed-adverse'
    if (readings.compaction.variantPropertyReads < readings.compaction.referencePropertyReads) return 'confirmed-benefit'
    return 'not-confirmed'
  }
  if (readings.reports.variantSnapshotOpens > readings.reports.referenceSnapshotOpens) return 'confirmed-adverse'
  if (readings.reports.variantSnapshotOpens < readings.reports.referenceSnapshotOpens) return 'confirmed-benefit'
  return 'not-confirmed'
}

function looAttribution(
  label: ComponentLooVariant, reference: LooMetrics, variant: LooMetrics, referenceBatch: V2BatchEvidence, variantBatch: V2BatchEvidence,
  mechanism: string,
) {
  const qualityLoss = Math.max(reference.reliableSuccesses - variant.reliableSuccesses, reference.artifactAccepted - variant.artifactAccepted)
  const qualityWithinTolerance = qualityLoss <= componentLooProtocol.qualityTolerance
  const reviewRequired = qualityLoss > componentLooProtocol.qualityTolerance
  const output = looDelta(reference.outputTokens, variant.outputTokens)
  const active = looDelta(reference.activeDurationMs, variant.activeDurationMs)
  const nonModel = looDelta(reference.nonModelActiveDurationMs, variant.nonModelActiveDurationMs)
  const preview = label === 'no-preview'
  const worse = preview ? [output, active].filter(item => item.worseWhenRemoved) : [nonModel].filter(item => item.worseWhenRemoved)
  const better = preview ? [output, active].filter(item => item.betterWhenRemoved) : [nonModel].filter(item => item.betterWhenRemoved)
  const repeatOutput = repeatDistribution(referenceBatch, variantBatch, row => row.metrics.outputTokens)
  const repeatActive = repeatDistribution(referenceBatch, variantBatch, row => row.metrics.activeDurationMs)
  const repeatNonModel = repeatDistribution(referenceBatch, variantBatch, row => looNonModel(row))
  const worseRepeats = preview
    ? [repeatOutput, repeatActive].filter((_, index) => (index === 0 ? output : active).worseWhenRemoved)
    : [repeatNonModel]
  const repeatConsistent = worseRepeats.every(distribution => signConsistent(Object.values(distribution).map(item => item.variant - item.reference)))
  const reasons: string[] = []
  let status: 'signal' | 'inconclusive' | 'efficiency-tradeoff' = 'inconclusive'
  if (reviewRequired) reasons.push('quality-loss-beyond-tolerance')
  else if (better.length && qualityLoss >= 1) { status = 'efficiency-tradeoff'; reasons.push('resource-better-with-quality-loss') }
  else if (worse.length && qualityWithinTolerance && repeatConsistent && mechanism === 'confirmed-adverse') status = 'signal'
  else {
    if (worse.length && !repeatConsistent) reasons.push('repeat-directions-conflict')
    if (worse.length && mechanism !== 'confirmed-adverse') reasons.push('mechanism-not-confirmed')
    if (!worse.length && !better.length) reasons.push('resource-change-below-threshold')
  }
  if (!preview && active.worseWhenRemoved && !nonModel.worseWhenRemoved) reasons.push('total-active-confounded-by-model-wait')
  if (mechanism === 'confirmed-adverse' && status === 'inconclusive') reasons.push(preview ? 'offline-retention-loss-without-paid-signal' : 'offline-cpu-io-only-below-paid-threshold')
  if (mechanism === 'not-measured') reasons.push('offline-probe-not-measured')
  return {
    status, reasons, thresholdPct: LOO_THRESHOLD * 100, qualityLoss, qualityWithinTolerance, reviewRequired, repeatConsistent,
    deltaBasis: 'full - no-X; positive means full consumed more or scored higher',
    resources: { outputTokens: output, activeDurationMs: active, nonModelActiveDurationMs: nonModel },
    repeats: { outputTokens: repeatOutput, activeDurationMs: repeatActive, nonModelActiveDurationMs: repeatNonModel },
    mechanism,
  }
}

export interface LooVariantResult {
  variant: Exclude<ComponentLooVariant, 'full'>
  sourceBaseCommit?: string | null
  evaluationCommit?: string
  manifestDigest: string
  observationsDigest: string
  startedAt?: string
  finishedAt?: string
  spentUsdEstimate: number | null
  metrics: { reference: LooMetrics; variant: LooMetrics }
  resources: Record<string, LooDelta>
  quality: {
    reliableCompletion: { reference: number; variant: number; fullMinusVariant: number; tolerance: number }
    artifactAcceptance: { reference: number; variant: number; fullMinusVariant: number; tolerance: number }
  }
  tasks: LooTaskPair[]
  source: { changed: string[]; expected: readonly string[] }
  offline: { status: string; readings?: ReturnType<typeof probeReadings>; probeSha256?: string; suiteSha256?: string }
  attribution: ReturnType<typeof looAttribution>
  reviewRequired: boolean
}

const looFailed = (message: string): never => { throw new Error(`LOO batches are not comparable: ${message}`) }

function assertLooComparable(reference: V2BatchEvidence, variants: Record<Exclude<ComponentLooVariant, 'full'>, V2BatchEvidence>, options: LooCompareOptions) {
  const labels = Object.keys(variants) as ComponentLooVariant[]
  if (labels.length !== LOO_NON_REFERENCE.length || !LOO_NON_REFERENCE.every(label => labels.includes(label))) looFailed('exactly no-preview, no-projection and no-report are required')
  if (reference.manifest.split !== LOO_SPLIT || reference.manifest.protocol !== LOO_PROTOCOL || reference.manifest.variant !== 'full') looFailed('reference protocol, split or variant')
  const all: [ComponentLooVariant, V2BatchEvidence][] = [['full', reference], ...LOO_NON_REFERENCE.map(label => [label, variants[label]] as [ComponentLooVariant, V2BatchEvidence])]
  for (const label of LOO_NON_REFERENCE) {
    if (stable(reference.manifest.sourceFiles.map(file => file.path)) !== stable(variants[label].manifest.sourceFiles.map(file => file.path))) looFailed(`source paths added or deleted: ${label}`)
    const changed = sourceChanges(reference, variants[label])
    const expected = [...looExpectedSourcePaths[label]].sort()
    const missing = expected.filter(file => !changed.includes(file))
    const unexpected = changed.filter(file => !expected.includes(file))
    if (missing.length || unexpected.length) looFailed(`source paths for ${label}; missing [${missing.join(', ')}], unexpected [${unexpected.join(', ')}]`)
  }
  const first = reference.manifest
  const seenBases = new Set<string>(), seenCommits = new Set<string>()
  for (const [label, batch] of all) {
    const manifest = batch.manifest
    if (manifest.protocol !== LOO_PROTOCOL || manifest.split !== LOO_SPLIT || manifest.variant !== label) looFailed(`protocol/split/variant: ${label}`)
    if (stable(manifest.tasks) !== stable(first.tasks) || stable(manifest.episodes) !== stable(first.episodes)) looFailed(`task contracts or schedule: ${label}`)
    if (stable(manifest.arms) !== stable(first.arms) || manifest.arms.length !== 1 || manifest.arms[0]!.name !== 'context') looFailed(`single context arm: ${label}`)
    if (manifest.scheduleSeed !== first.scheduleSeed || manifest.tier !== '1m' || manifest.window !== 1_000_000) looFailed(`seed or tier/window: ${label}`)
    for (const field of ['model', 'echoedModel', 'modelVersion', 'thinking', 'sampling', 'baseUrl'] as const) if (manifest[field] !== first[field]) looFailed(`${field}: ${label}`)
    if (stable(manifest.priceSnapshot) !== stable(first.priceSnapshot)) looFailed(`price snapshot: ${label}`)
    if (!isHex(manifest.toolSchemaSha256, 64) || manifest.toolSchemaSha256 !== first.toolSchemaSha256) looFailed(`tool schema: ${label}`)
    if (!isHex(manifest.sourceBaseCommit, 40) || manifest.sourceBaseCommit === manifest.gitCommit) looFailed(`source base commit: ${label}`)
    if (seenBases.has(manifest.sourceBaseCommit!)) looFailed(`duplicate source base commit: ${label}`)
    seenBases.add(manifest.sourceBaseCommit!)
    if (seenCommits.has(manifest.gitCommit)) looFailed(`duplicate evaluation commit: ${label}`)
    seenCommits.add(manifest.gitCommit)
    if (batch.report.incomplete || batch.report.missing.length || batch.report.invalid.length || batch.report.stopped !== false) looFailed(`incomplete or stopped batch: ${label}`)
    if (batch.report.planned !== componentLooProtocol.episodes || batch.report.executed !== componentLooProtocol.episodes || batch.observations.length !== componentLooProtocol.episodes) looFailed(`fixed 12-episode denominator: ${label}`)
    const recomputed = reportV2(manifest, batch.observations)
    for (const field of ['manifestDigest', 'observationsDigest', 'planned', 'executed', 'incomplete', 'missing', 'invalid'] as const) {
      if (stable(batch.report[field]) !== stable(recomputed[field])) looFailed(`stale report ${field}: ${label}`)
    }
    if (batch.report.evaluationCommit !== manifest.gitCommit || batch.report.sourceBaseCommit !== manifest.sourceBaseCommit) looFailed(`report provenance: ${label}`)
    const metrics = looMetrics(batch)
    if (metrics.estimatedTokens !== 0 || metrics.providerTokens <= 0 || !batch.observations.every(row => row.metrics.providerTokens > 0)) looFailed(`provider usage coverage: ${label}`)
    if (!batch.report.environment || stable(batch.report.environment) !== stable(reference.report.environment)) looFailed(`environment: ${label}`)
    if (batch.packageSha256 !== reference.packageSha256 || stable(batch.packageJson) !== stable(reference.packageJson)) looFailed(`package.json: ${label}`)
    parseTime(batch.report.startedAt, `${label} startedAt`)
    parseTime(batch.report.finishedAt, `${label} finishedAt`)
    if (Date.parse(batch.report.finishedAt!) < Date.parse(batch.report.startedAt!)) looFailed(`batch finished before start: ${label}`)
  }
  const ordered = all.map(([label, batch]) => ({ label, start: Date.parse(batch.report.startedAt!), end: Date.parse(batch.report.finishedAt!) })).sort((a, b) => a.start - b.start)
  for (let index = 1; index < ordered.length; index += 1) if (ordered[index - 1]!.end > ordered[index]!.start) looFailed('batch time windows overlap')
  if (stable(ordered.map(batch => batch.label)) !== stable(componentLooProtocol.batchOrder)) looFailed('pre-registered batch order')
  if (options.expectedSourceBaseCommits && Object.keys(options.expectedSourceBaseCommits).length) {
    for (const [label, batch] of all) {
      const expected = options.expectedSourceBaseCommits[label]
      if (expected === undefined) looFailed(`expected source base missing: ${label}`)
      if (batch.manifest.sourceBaseCommit !== expected) looFailed(`source base pin mismatch: ${label}`)
    }
  }
}

export function compareV2LooBatches(
  reference: V2BatchEvidence,
  variants: Record<Exclude<ComponentLooVariant, 'full'>, V2BatchEvidence>,
  options: LooCompareOptions = {},
) {
  assertLooComparable(reference, variants, options)
  const probes = assertLooProbes(reference, variants, options.probes)
  const referenceProbe = probes?.find(([label]) => label === 'full')?.[1]
  const referenceMetrics = looMetrics(reference)
  const variantResults = Object.fromEntries(LOO_NON_REFERENCE.map(label => {
    const batch = variants[label]
    const metrics = looMetrics(batch)
    const variantProbe = probes?.find(([candidate]) => candidate === label)?.[1]
    const mechanism = mechanismStatus(label, referenceProbe, variantProbe)
    const attribution = looAttribution(label, referenceMetrics, metrics, reference, batch, mechanism)
    return [label, {
      variant: label, sourceBaseCommit: batch.manifest.sourceBaseCommit, evaluationCommit: batch.manifest.gitCommit,
      manifestDigest: batch.manifest.digest, observationsDigest: batch.report.observationsDigest,
      startedAt: batch.report.startedAt, finishedAt: batch.report.finishedAt, spentUsdEstimate: batch.report.spentUsdEstimate ?? null,
      metrics: { reference: referenceMetrics, variant: metrics },
      resources: {
        tokens: looDelta(referenceMetrics.tokens, metrics.tokens), outputTokens: looDelta(referenceMetrics.outputTokens, metrics.outputTokens),
        cacheReadTokens: looDelta(referenceMetrics.cacheReadTokens, metrics.cacheReadTokens), activeDurationMs: looDelta(referenceMetrics.activeDurationMs, metrics.activeDurationMs),
        modelActiveDurationMs: looDelta(referenceMetrics.modelActiveDurationMs, metrics.modelActiveDurationMs),
        nonModelActiveDurationMs: looDelta(referenceMetrics.nonModelActiveDurationMs, metrics.nonModelActiveDurationMs),
        requests: looDelta(referenceMetrics.requests, metrics.requests), summaryRequests: looDelta(referenceMetrics.summaryRequests, metrics.summaryRequests),
        summaryDurationMs: looDelta(referenceMetrics.summaryDurationMs, metrics.summaryDurationMs),
        toolCalls: looDelta(referenceMetrics.toolCalls, metrics.toolCalls), toolErrors: looDelta(referenceMetrics.toolErrors, metrics.toolErrors),
        previewTruncations: looDelta(referenceMetrics.previewTruncations, metrics.previewTruncations),
        pressureCompactions: looDelta(referenceMetrics.pressureCompactions, metrics.pressureCompactions),
      },
      quality: {
        reliableCompletion: { reference: referenceMetrics.reliableSuccesses, variant: metrics.reliableSuccesses, fullMinusVariant: referenceMetrics.reliableSuccesses - metrics.reliableSuccesses, tolerance: TOLERANCE_EPISODES },
        artifactAcceptance: { reference: referenceMetrics.artifactAccepted, variant: metrics.artifactAccepted, fullMinusVariant: referenceMetrics.artifactAccepted - metrics.artifactAccepted, tolerance: TOLERANCE_EPISODES },
      },
      tasks: looTaskPairs(reference, batch),
      source: { changed: sourceChanges(reference, batch), expected: looExpectedSourcePaths[label] },
      offline: {
        status: mechanism,
        ...(referenceProbe && variantProbe ? { readings: probeReadings(referenceProbe, variantProbe), probeSha256: variantProbe.sha256, suiteSha256: variantProbe.suiteSha256 } : {}),
      },
      attribution,
      reviewRequired: attribution.reviewRequired,
    }]
  })) as unknown as Record<Exclude<ComponentLooVariant, 'full'>, LooVariantResult>
  return {
    protocol: LOO_PROTOCOL, gateVersion: LOO_GATE_VERSION, createdAt: new Date().toISOString(),
    interpretation: 'development-only-descriptive', significanceClaim: false,
    reference: {
      variant: 'full', sourceBaseCommit: reference.manifest.sourceBaseCommit, evaluationCommit: reference.manifest.gitCommit,
      manifestDigest: reference.manifest.digest, observationsDigest: reference.report.observationsDigest,
      startedAt: reference.report.startedAt, finishedAt: reference.report.finishedAt, spentUsdEstimate: reference.report.spentUsdEstimate ?? null,
      metrics: referenceMetrics,
    },
    variants: variantResults,
    checks: {
      protocol: true, split: true, tasks: true, episodes: true, arms: true, seed: true, tierWindow: true, model: true,
      priceSnapshot: true, toolSchema: true, environment: true, packageJson: true, complete: true, providerCoverage: true,
      batchOrder: true, sourcePaths: true, probes: probes === undefined ? 'not-measured' : true,
    },
    measurementLimits: [
      'Six tasks x two repeats per arm; this is a development-only descriptive attribution, not a significance test or a generalization claim.',
      'The four batches ran sequentially; provider prompt cache may be shared and no causal latency claim is made.',
      'Token totals are input + output from provider usage; cache-hit savings are reported separately and are not treated as total-token reductions.',
      'nonModelActiveDurationMs = activeDurationMs - sum(requestDurationsMs), clipped at zero. It includes tool execution, isolation and local I/O; it is a proxy, not CPU time.',
      'Offline probes measure mechanism cost and information retention, not model behavior. They do not upgrade a paid result to a signal by themselves.',
    ],
  }
}

export type V2LooComparison = ReturnType<typeof compareV2LooBatches>

export interface LooCompareArguments {
  referenceRoot: string
  variants: Record<Exclude<ComponentLooVariant, 'full'>, string>
  output: string
  referenceProbe?: string
  variantProbes: Partial<Record<Exclude<ComponentLooVariant, 'full'>, string>>
  expectedSourceBaseCommits: Partial<Record<ComponentLooVariant, string>>
}

export function parseLooCompareArguments(argv: readonly string[]): LooCompareArguments {
  const single = new Map<string, string>()
  const variants = new Map<Exclude<ComponentLooVariant, 'full'>, string>()
  const variantProbes = new Map<Exclude<ComponentLooVariant, 'full'>, string>()
  const expected = new Map<ComponentLooVariant, string>()
  const repeatable = new Set(['variant', 'variant-probe', 'expect-source-base'])
  const allowed = new Set(['reference-evidence-root', 'reference-probe', 'output', ...repeatable])
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === undefined || !token.startsWith('--')) throw new Error(`unexpected argument: ${String(token)}`)
    const [key, inline] = token.slice(2).split('=', 2)
    if (key === undefined || !allowed.has(key)) throw new Error(`unknown LOO option: --${String(key)}`)
    if (key === 'variant' || key === 'variant-probe' || key === 'expect-source-base') {
      if (repeatable.has(key) && single.has(key)) throw new Error(`--${key} is not a single-value option`)
    } else if (single.has(key)) throw new Error(`duplicate option: --${key}`)
    const value = inline ?? argv[++index]
    if (!value || value.startsWith('--')) throw new Error(`--${key} needs a value`)
    if (!repeatable.has(key)) { single.set(key, value); continue }
    const [label, target] = value.split('=', 2)
    if (!label || !target) throw new Error(`--${key} needs LABEL=VALUE`)
    if (!(LOO_VARIANTS as readonly string[]).includes(label)) throw new Error(`unknown variant label: ${label}`)
    if (key === 'expect-source-base') {
      if (!isHex(target, 40)) throw new Error(`--expect-source-base needs a 40-hex commit: ${label}`)
      if (expected.has(label as ComponentLooVariant)) throw new Error(`duplicate expected source base: ${label}`)
      expected.set(label as ComponentLooVariant, target)
      continue
    }
    if (label === 'full') throw new Error(`--${key} is only valid for a no-X variant`)
    if (key === 'variant' && variants.has(label as Exclude<ComponentLooVariant, 'full'>)) throw new Error(`duplicate variant: ${label}`)
    if (key === 'variant-probe' && variantProbes.has(label as Exclude<ComponentLooVariant, 'full'>)) throw new Error(`duplicate variant probe: ${label}`)
    if (key === 'variant') variants.set(label as Exclude<ComponentLooVariant, 'full'>, path.resolve(target))
    else variantProbes.set(label as Exclude<ComponentLooVariant, 'full'>, path.resolve(target))
  }
  const referenceRoot = single.get('reference-evidence-root'), output = single.get('output'), referenceProbe = single.get('reference-probe')
  if (!referenceRoot || !output) throw new Error('usage: eval:v2-compare --reference-evidence-root DIR --variant LABEL=DIR ... --output FILE [--reference-probe FILE --variant-probe LABEL=FILE ...] [--expect-source-base LABEL=HEX ...]')
  for (const label of LOO_NON_REFERENCE) if (!variants.has(label as Exclude<ComponentLooVariant, 'full'>)) throw new Error(`missing --variant ${label}=DIR`)
  if (referenceProbe !== undefined || variantProbes.size) {
    if (!referenceProbe) throw new Error('--reference-probe is required when any --variant-probe is supplied')
    for (const label of LOO_NON_REFERENCE) if (!variantProbes.has(label as Exclude<ComponentLooVariant, 'full'>)) throw new Error(`missing --variant-probe ${label}=FILE`)
  }
  if (expected.size && expected.size !== LOO_VARIANTS.length) throw new Error('--expect-source-base must be supplied for all four variants')
  return { referenceRoot: path.resolve(referenceRoot), variants: Object.fromEntries(variants) as LooCompareArguments['variants'], output: path.resolve(output),
    ...(referenceProbe === undefined ? {} : { referenceProbe: path.resolve(referenceProbe) }), variantProbes: Object.fromEntries(variantProbes), expectedSourceBaseCommits: Object.fromEntries(expected) }
}

async function looMain(args: readonly string[]) {
  const parsed = parseLooCompareArguments(args)
  if (args.some(arg => arg.startsWith('--old-evidence-root') || arg.startsWith('--new-evidence-root') || arg.startsWith('--expect-old-base') || arg.startsWith('--expect-new-base'))) throw new Error('legacy NX-50 and LOO comparator arguments cannot be mixed')
  const reference = await readV2BatchEvidence(parsed.referenceRoot)
  const variants = Object.fromEntries(await Promise.all(LOO_NON_REFERENCE.map(async label =>
    [label, await readV2BatchEvidence(parsed.variants[label as Exclude<ComponentLooVariant, 'full'>])]))) as Record<Exclude<ComponentLooVariant, 'full'>, V2BatchEvidence>
  const probes = parsed.referenceProbe === undefined ? undefined : {
    reference: await readV2OfflineProbe(parsed.referenceProbe),
    variants: Object.fromEntries(await Promise.all(LOO_NON_REFERENCE.map(async label =>
      [label, await readV2OfflineProbe(parsed.variantProbes[label as Exclude<ComponentLooVariant, 'full'>]!)]))) as LooProbes['variants'],
  }
  const comparison = compareV2LooBatches(reference, variants, { probes, expectedSourceBaseCommits: parsed.expectedSourceBaseCommits })
  await fs.writeFile(parsed.output, `${JSON.stringify(comparison, null, 2)}\n`, { flag: 'wx' })
  console.log(JSON.stringify({ output: parsed.output, gate: comparison.checks, variants: Object.fromEntries(Object.entries(comparison.variants).map(([label, result]) => {
    const item = result as { attribution: { status: string; reasons: string[] }; reviewRequired: boolean }
    return [label, { status: item.attribution.status, reasons: item.attribution.reasons, reviewRequired: item.reviewRequired }]
  })) }))
  if (Object.values(comparison.variants).some(result => (result as { reviewRequired: boolean }).reviewRequired)) process.exitCode = 2
}

async function main() {
  const args = process.argv.slice(2)
  if (args.some(arg => arg === '--reference-evidence-root' || arg.startsWith('--reference-evidence-root='))) {
    await looMain(args)
    return
  }
  const values = new Map<string, string>()
  const allowed = new Set(['old-evidence-root', 'new-evidence-root', 'output', 'expect-old-base', 'expect-new-base'])
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (!token?.startsWith('--')) throw new Error(`unexpected argument: ${String(token)}`)
    const [key, inline] = token.slice(2).split('=', 2)
    if (key === undefined || !allowed.has(key) || values.has(key)) throw new Error(`invalid or duplicate option: --${String(key)}`)
    const value = inline ?? args[++index]
    if (!value || value.startsWith('--')) throw new Error(`--${key} needs a value`)
    values.set(key, value)
  }
  const oldRoot = values.get('old-evidence-root'), newRoot = values.get('new-evidence-root'), output = values.get('output')
  if (!oldRoot || !newRoot || !output) throw new Error('usage: eval:v2-compare --old-evidence-root DIR --new-evidence-root DIR --output FILE [--expect-old-base HEX --expect-new-base HEX]')
  const oldBatch = await readV2BatchEvidence(oldRoot), newBatch = await readV2BatchEvidence(newRoot)
  const expectedOld = values.get('expect-old-base'), expectedNew = values.get('expect-new-base')
  if ((expectedOld && oldBatch.manifest.sourceBaseCommit !== expectedOld) || (expectedNew && newBatch.manifest.sourceBaseCommit !== expectedNew)) {
    throw new Error('evidence sourceBaseCommit does not match the expected pinned commit')
  }
  const comparison = compareV2Batches(oldBatch, newBatch)
  await fs.writeFile(path.resolve(output), `${JSON.stringify(comparison, null, 2)}\n`, { flag: 'wx' })
  console.log(JSON.stringify({ output, gate: comparison.gate, reliable: comparison.reliableCompletion, artifact: comparison.artifactAcceptance, tokens: comparison.tokens, activeTime: comparison.activeTime }))
  if (comparison.gate.status === 'review-required') process.exitCode = 2
  else if (comparison.gate.status !== 'pass') process.exitCode = 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
