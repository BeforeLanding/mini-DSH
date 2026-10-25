import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { reliableSuccess, reportV2 } from './eval-v2-report.js'
import type { V2Manifest, V2Observation, V2Report } from './eval-v2-report.js'
import { repeatsForV2Split } from './eval-v2-plan.js'

const PROTOCOL = 'NX-50-component-ab-v1' as const
const GATE_VERSION = 'nx50-component-gate-v1' as const
const TOLERANCE_EPISODES = 1
const MAX_RESOURCE_RATIO = 1.15
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

async function main() {
  const args = process.argv.slice(2)
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
