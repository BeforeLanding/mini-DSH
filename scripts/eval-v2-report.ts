import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { createHarness } from '../src/app/create-harness.js'
import { armsForV2Split, repeatsForV2Split, resolveV2Arms, resolveV2Episodes, seedForV2Split, tasksForV2Split } from './eval-v2-plan.js'
import type { V2Episode, V2Split, V2Tier } from './eval-v2-plan.js'
import type { AblationPhase } from './eval-runner.js'

export interface V2FreezeInput {
  split: V2Split
  tier: V2Tier
  window: number
  model: string
  echoedModel: string
  modelVersion?: string
  thinking: 'enabled' | 'disabled'
  sampling: 'provider-default'
  baseUrl: string
  priceSnapshot: { source: string; capturedAt: string; currency: string; inputPerMillion: number; outputPerMillion: number; cacheReadPerMillion: number }
  gitCommit: string
}
export interface V2FrozenFile { path: string; sha256: string }
export interface V2Manifest extends V2FreezeInput {
  protocol: 'NX-42-eval-v2' | 'NX-42-eval-v2.1' | 'NX-45-dev-2arm-v1'
  scheduleSeed: number
  tasks: readonly { id: string; family: string; shape: string; groups: string[]; files: V2FrozenFile[] }[]
  arms: ReturnType<typeof resolveV2Arms>
  episodes: readonly V2Episode[]
  sourceFiles: V2FrozenFile[]
  toolSchemaSha256?: string
  digest: string
}

const fixtureRoot = fileURLToPath(new URL('../../test/fixtures/harness-v2/', import.meta.url))
const repository = fileURLToPath(new URL('../../', import.meta.url))
const sourcePaths = [
  'AGENTS.md', 'package.json', 'pnpm-lock.yaml', 'biome.jsonc', 'docs/context-budget/NX-42-EVAL-V2-PLAN.md',
  'scripts/eval-v2-plan.ts', 'scripts/eval-v2-episode.ts', 'scripts/eval-v2-fixtures.ts',
  'scripts/eval-v2-isolation.ts', 'scripts/eval-fixture.ts', 'scripts/eval-runner.ts',
  'scripts/eval-v2-report.ts', 'scripts/eval-v2-freeze.ts', 'scripts/eval-v2.ts', 'scripts/eval-v2-runtime.sha256',
  'scripts/eval-capabilities.mjs',
  'scripts/eval-v2-observation.ts', 'scripts/eval-v2-run.ts',
  'scripts/eval-v2-prepare-runtime.sh', 'scripts/coding-fixtures.ts', 'scripts/eval-provenance.ts',
  'test/fixtures/harness-v2/_shared/probe.mjs',
]
const frozenSourcePaths = (split: V2Split) => split === 'development' ? [...sourcePaths, 'scripts/smoke-cost.ts', 'docs/context-budget/NX-45-DEVELOPMENT.md'] : sourcePaths
const sha = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')
const stable = (value: unknown): string => JSON.stringify(value)
const quantile = (values: readonly number[], q: number): number | null => {
  if (!values.length) return null
  const ordered = [...values].sort((a, b) => a - b)
  return ordered[Math.ceil(q * ordered.length) - 1] ?? ordered[0]!
}
const mean = (values: readonly number[]): number | null => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
const stats = (values: readonly number[]) => ({ count: values.length, mean: mean(values), median: quantile(values, 0.5), p95: quantile(values, 0.95), total: values.reduce((a, b) => a + b, 0) })

async function currentToolSchemaSha256(): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-v2-schema-'))
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined
  try {
    harness = await createHarness({ workspace, profile: 'coding' })
    return harness.capabilityManifest.toolSchemaSha256
  } finally {
    if (harness) await harness.dispose()
    await fs.rm(workspace, { recursive: true, force: true })
  }
}

async function listFiles(root: string, relative = ''): Promise<V2FrozenFile[]> {
  const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true })
  const result: V2FrozenFile[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const name = path.posix.join(relative, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`freeze refuses symlink: ${name}`)
    if (entry.isDirectory()) result.push(...await listFiles(root, name))
    else if (entry.isFile()) result.push({ path: name, sha256: sha(await fs.readFile(path.join(root, name))) })
    else throw new Error(`freeze refuses non-file: ${name}`)
  }
  return result
}

export async function freezeV2(input: V2FreezeInput): Promise<V2Manifest> {
  if (input.split !== 'formal' && input.split !== 'calibration' && input.split !== 'development') throw new Error('invalid V2 split')
  if (input.tier !== '2m' && input.tier !== '1m') throw new Error('invalid V2 tier')
  if (input.split === 'development' && input.tier !== '1m') throw new Error('development protocol requires the shared 1m tier')
  if (input.split === 'development' && (input.window !== 1_000_000 || input.model !== 'deepseek/deepseek-flash' || input.echoedModel !== 'deepseek-flash' ||
    input.thinking !== 'enabled' || input.sampling !== 'provider-default' || !input.modelVersion)) throw new Error('development model contract mismatch')
  if (input.split === 'development' && input.priceSnapshot.source !== 'https://api-docs.deepseek.com/quick_start/pricing/') throw new Error('development price snapshot must use the official source')
  if (!input.model || !input.echoedModel || !input.baseUrl || !/^[0-9a-f]{40}$/.test(input.gitCommit) ||
    !['enabled', 'disabled'].includes(input.thinking) || input.sampling !== 'provider-default') throw new Error('freeze requires model, echo label, thinking, provider-default sampling, endpoint and clean Git commit')
  const price = input.priceSnapshot
  if (!price.source || !Number.isFinite(Date.parse(price.capturedAt)) || !price.currency ||
    [price.inputPerMillion, price.outputPerMillion, price.cacheReadPerMillion].some(value => !Number.isFinite(value) || value < 0) ||
    price.inputPerMillion === 0 || price.outputPerMillion === 0) throw new Error('invalid price snapshot')
  const tasks = tasksForV2Split(input.split)
  const frozenTasks = await Promise.all(tasks.map(async task => {
    const files = await listFiles(path.join(fixtureRoot, task.id))
    for (const required of ['meta.json', 'verify.mjs']) if (!files.some(file => file.path === required)) throw new Error(`incomplete fixture ${task.id}: ${required}`)
    if (!files.some(file => file.path.startsWith('initial/')) || !files.some(file => file.path.startsWith('reference/') || file.path.startsWith('oracle/')) ||
      !files.some(file => file.path === 'TASK.md' || file.path.startsWith('TASKS/'))) throw new Error(`incomplete fixture ${task.id}`)
    const meta = JSON.parse(await fs.readFile(path.join(fixtureRoot, task.id, 'meta.json'), 'utf8')) as { groups?: unknown }
    if (!Array.isArray(meta.groups) || meta.groups.length !== 4 || meta.groups.some(group => typeof group !== 'string') || new Set(meta.groups).size !== 4) throw new Error(`invalid V2 groups: ${task.id}`)
    return { ...task, groups: meta.groups as string[], files }
  }))
  const sourceFiles = [
    ...await Promise.all(frozenSourcePaths(input.split).map(async file => ({ path: file, sha256: sha(await fs.readFile(path.join(repository, file))) }))),
    ...(await listFiles(path.join(repository, 'src'))).map(file => ({ path: `src/${file.path}`, sha256: file.sha256 })),
  ].sort((a, b) => a.path.localeCompare(b.path, 'en'))
  const arms = resolveV2Arms(input.window, input.tier).filter(arm => armsForV2Split(input.split).includes(arm.name))
  const fields = { protocol: input.split === 'development' ? 'NX-45-dev-2arm-v1' as const : 'NX-42-eval-v2.1' as const,
    scheduleSeed: seedForV2Split(input.split), ...input, tasks: frozenTasks, arms, episodes: resolveV2Episodes(input.split), sourceFiles,
    ...(input.split === 'development' ? { toolSchemaSha256: await currentToolSchemaSha256() } : {}) }
  return { ...fields, digest: sha(stable(fields)) }
}

export async function verifyV2FrozenFiles(manifest: V2Manifest): Promise<void> {
  const { digest, ...fields } = manifest
  if (sha(stable(fields)) !== digest) throw new Error('V2 manifest digest mismatch')
  for (const task of manifest.tasks) {
    const actual = await listFiles(path.join(fixtureRoot, task.id))
    if (stable(actual) !== stable(task.files)) throw new Error(`V2 fixture changed after freeze: ${task.id}`)
    const meta = JSON.parse(await fs.readFile(path.join(fixtureRoot, task.id, 'meta.json'), 'utf8')) as { groups?: unknown }
    if (stable(meta.groups) !== stable(task.groups)) throw new Error(`V2 group contract changed after freeze: ${task.id}`)
  }
  const sources = [
    ...await Promise.all(frozenSourcePaths(manifest.split).map(async file => ({ path: file, sha256: sha(await fs.readFile(path.join(repository, file))) }))),
    ...(await listFiles(path.join(repository, 'src'))).map(file => ({ path: `src/${file.path}`, sha256: file.sha256 })),
  ].sort((a, b) => a.path.localeCompare(b.path, 'en'))
  if (stable(sources) !== stable(manifest.sourceFiles)) throw new Error('V2 source, prompt, schema or rules changed after freeze')
  if (manifest.split === 'development' && manifest.toolSchemaSha256 !== await currentToolSchemaSha256()) throw new Error('development tool schema changed after freeze')
}

export interface V2Observation {
  taskId: string
  repeat: number
  arm: AblationPhase
  status: string
  accepted: boolean | null
  acceptanceGroups: { name: string; passed: boolean }[]
  protectedFilesChanged: string[]
  evidenceComplete: boolean
  failureReason?: string
  providerHttpStatus?: number
  metrics: {
    mainRequests: number; summaryRequests: number; toolCalls: number; toolErrors: number; policyRejected: number | null; toolSkipped: number
    inputTokens: number; outputTokens: number; summaryTokens: number; cacheReadTokens: number
    providerTokens: number; estimatedTokens: number; activeDurationMs: number; requestDurationsMs: number[]; summaryDurationMs: number; timeouts: number
    pressureCompactions: number; prunedTaskIds: string[]; previewTruncations: number; stablePromptRuns: number; multiRoundRuns: number
  }
}
export const reliableSuccess = (record: V2Observation): boolean => record.status === 'completed' && record.accepted === true &&
  record.acceptanceGroups.length === 4 && record.acceptanceGroups.every(group => group.passed) && !record.protectedFilesChanged.length && record.evidenceComplete

function validateObservation(record: V2Observation): void {
  if (!record || typeof record !== 'object' || !record.metrics || !Array.isArray(record.acceptanceGroups) || !Array.isArray(record.protectedFilesChanged)) throw new Error('invalid V2 observation')
  if (typeof record.taskId !== 'string' || typeof record.status !== 'string' || typeof record.evidenceComplete !== 'boolean' ||
    ![true, false, null].includes(record.accepted) || !record.acceptanceGroups.every(group => typeof group.name === 'string' && typeof group.passed === 'boolean') ||
    !record.protectedFilesChanged.every(file => typeof file === 'string')) throw new Error('invalid V2 observation fields')
  const numericKeys: (keyof V2Observation['metrics'])[] = ['mainRequests', 'summaryRequests', 'toolCalls', 'toolErrors', 'toolSkipped',
    'inputTokens', 'outputTokens', 'summaryTokens', 'cacheReadTokens', 'providerTokens', 'estimatedTokens', 'activeDurationMs',
    'summaryDurationMs', 'timeouts', 'pressureCompactions', 'previewTruncations', 'stablePromptRuns', 'multiRoundRuns']
  if (numericKeys.some(key => typeof record.metrics[key] !== 'number' || !Number.isFinite(record.metrics[key]) || (record.metrics[key] as number) < 0) ||
    !Array.isArray(record.metrics.requestDurationsMs) || record.metrics.requestDurationsMs.some(value => !Number.isFinite(value) || value < 0) ||
    !Array.isArray(record.metrics.prunedTaskIds) || record.metrics.prunedTaskIds.some(value => typeof value !== 'string')) throw new Error(`invalid V2 metrics: ${record.taskId}`)
  if (record.metrics.toolErrors > record.metrics.toolCalls) throw new Error(`V2 tool errors exceed calls: ${record.taskId}`)
  if (record.metrics.policyRejected !== null && (!Number.isSafeInteger(record.metrics.policyRejected) || record.metrics.policyRejected < 0)) throw new Error(`invalid V2 policy rejections: ${record.taskId}`)
  if (record.providerHttpStatus !== undefined && (!Number.isInteger(record.providerHttpStatus) || record.providerHttpStatus < 100 || record.providerHttpStatus > 599)) throw new Error(`invalid V2 provider status: ${record.taskId}`)
  if (!['baseline', 'context', 'prompt', 'full'].includes(record.arm) || !Number.isInteger(record.repeat) || record.repeat < 0) throw new Error('invalid V2 arm/repeat')
}

function bootstrapDelta(manifest: V2Manifest, observations: readonly V2Observation[], first: AblationPhase, second: AblationPhase): { estimate: number | null; lower95: number | null; upper95: number | null; complete: boolean } {
  if (observations.some(record => record.failureReason === 'infrastructure' || record.status === 'error')) return { estimate: null, lower95: null, upper95: null, complete: false }
  const arms = [first, second] as const
  const roots = manifest.tasks.map(task => task.id)
  const expectedRepeats = repeatsForV2Split(manifest.split)
  const byKey = new Map(observations.map(record => [`${record.taskId}/${record.repeat}/${record.arm}`, record]))
  const perRoot = roots.map(id => {
    const values = arms.map(arm => Array.from({ length: expectedRepeats }, (_, repeat) => byKey.get(`${id}/${repeat}/${arm}`)))
    return values.every(group => group.every(Boolean)) ? (values[1]!.filter(record => reliableSuccess(record!)).length - values[0]!.filter(record => reliableSuccess(record!)).length) / expectedRepeats : null
  })
  if (perRoot.some(value => value === null)) return { estimate: null, lower95: null, upper95: null, complete: false }
  const estimate = mean(perRoot as number[])!
  const byFamily = new Map<string, number[]>()
  for (const [index, task] of manifest.tasks.entries()) byFamily.set(task.family, [...(byFamily.get(task.family) ?? []), perRoot[index]!])
  let state = seedForV2Split(manifest.split) >>> 0
  const random = (): number => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0 }
  const draws: number[] = []
  for (let index = 0; index < 10_000; index += 1) {
    const sampled: number[] = []
    for (const family of byFamily.values()) for (let count = 0; count < family.length; count += 1) sampled.push(family[random() % family.length]!)
    draws.push(mean(sampled)!)
  }
  return { estimate, lower95: quantile(draws, 0.025), upper95: quantile(draws, 0.975), complete: true }
}

export function reportV2(manifest: V2Manifest, observations: readonly V2Observation[]) {
  const { digest, ...fields } = manifest
  const expectedTasks = tasksForV2Split(manifest.split)
  if (sha(stable(fields)) !== digest || (manifest.split === 'development' ? manifest.protocol !== 'NX-45-dev-2arm-v1' : !['NX-42-eval-v2', 'NX-42-eval-v2.1'].includes(manifest.protocol)) ||
    manifest.scheduleSeed !== seedForV2Split(manifest.split) || (manifest.split === 'development' && manifest.tier !== '1m') ||
    (manifest.split === 'development' && (!/^[a-f0-9]{64}$/.test(manifest.toolSchemaSha256 ?? '') || !manifest.modelVersion || manifest.window !== 1_000_000 ||
      manifest.model !== 'deepseek/deepseek-flash' || manifest.echoedModel !== 'deepseek-flash' || manifest.thinking !== 'enabled' || manifest.sampling !== 'provider-default')) ||
    stable(manifest.tasks.map(({ id, family, shape }) => ({ id, family, shape }))) !== stable(expectedTasks) ||
    stable(manifest.episodes) !== stable(resolveV2Episodes(manifest.split)) ||
    stable(manifest.arms) !== stable(resolveV2Arms(manifest.window, manifest.tier).filter(arm => armsForV2Split(manifest.split).includes(arm.name)))) throw new Error('V2 manifest integrity or schedule mismatch')
  const expected = new Map(manifest.episodes.map(episode => [`${episode.taskId}/${episode.repeat}/${episode.arm}`, episode]))
  const seen = new Map<string, V2Observation>()
  for (const record of observations) {
    validateObservation(record)
    const key = `${record.taskId}/${record.repeat}/${record.arm}`
    if (!expected.has(key) || seen.has(key)) throw new Error(`unknown or duplicate V2 episode: ${key}`)
    const contracts = manifest.tasks.find(task => task.id === record.taskId)?.groups
    if (!contracts || (record.acceptanceGroups.length && stable(record.acceptanceGroups.map(group => group.name)) !== stable(contracts))) throw new Error(`V2 contract group mismatch: ${key}`)
    seen.set(key, record)
  }
  const missing = [...expected.keys()].filter(key => !seen.has(key))
  const invalid = observations.filter(record => record.failureReason === 'infrastructure' || record.status === 'error')
    .map(record => `${record.taskId}/${record.repeat}/${record.arm}`)
  const arms = manifest.arms.map(arm => {
    const rows = observations.filter(record => record.arm === arm.name)
    const planned = manifest.episodes.filter(episode => episode.arm === arm.name).length
    const successes = rows.filter(reliableSuccess).length
    const numbers = (field: keyof V2Observation['metrics']) => rows.map(row => row.metrics[field]).filter((value): value is number => typeof value === 'number')
    const requestDurations = rows.flatMap(row => row.metrics.requestDurationsMs)
    const reasons: Record<string, number> = {}
    for (const row of rows.filter(row => !reliableSuccess(row))) {
      const reason = row.failureReason ?? (row.status !== 'completed' ? row.status : row.accepted === false ? 'acceptance' : 'evidence')
      reasons[reason] = (reasons[reason] ?? 0) + 1
    }
    return {
      arm: arm.name, planned, executed: rows.length, reliableSuccesses: successes, rateLower: successes / planned,
      rateUpper: (successes + planned - rows.length + rows.filter(row => row.failureReason === 'infrastructure' || row.status === 'error').length) / planned,
      artifactAccepted: rows.filter(row => row.accepted === true).length,
      failureReasons: reasons,
      modelRounds: { main: stats(numbers('mainRequests')), summary: stats(numbers('summaryRequests')), all: stats(rows.map(row => row.metrics.mainRequests + row.metrics.summaryRequests)) },
      tools: { calls: stats(numbers('toolCalls')), errors: stats(numbers('toolErrors')), policyRejected: rows.some(row => row.metrics.policyRejected !== null) ? stats(numbers('policyRejected')) : null, skipped: stats(numbers('toolSkipped')),
        errorRate: rows.reduce((sum, row) => sum + row.metrics.toolCalls, 0) ? rows.reduce((sum, row) => sum + row.metrics.toolErrors, 0) / rows.reduce((sum, row) => sum + row.metrics.toolCalls, 0) : null },
      tokens: { input: stats(numbers('inputTokens')), output: stats(numbers('outputTokens')), summary: stats(numbers('summaryTokens')), cacheRead: stats(numbers('cacheReadTokens')),
        providerTokens: stats(numbers('providerTokens')), estimatedTokens: stats(numbers('estimatedTokens')),
        estimatedUsd: rows.reduce((sum, row) => sum + (
          Math.max(0, row.metrics.inputTokens - row.metrics.cacheReadTokens) * manifest.priceSnapshot.inputPerMillion +
          row.metrics.cacheReadTokens * manifest.priceSnapshot.cacheReadPerMillion + row.metrics.outputTokens * manifest.priceSnapshot.outputPerMillion
        ) / 1_000_000, 0),
        tokensPerReliableSuccess: successes ? rows.reduce((sum, row) => sum + row.metrics.inputTokens + row.metrics.outputTokens, 0) / successes : null },
      latency: { active: stats(numbers('activeDurationMs')), request: stats(requestDurations), summary: stats(numbers('summaryDurationMs')), timeouts: rows.reduce((sum, row) => sum + row.metrics.timeouts, 0) },
      mechanisms: { pressureCompactions: rows.reduce((sum, row) => sum + row.metrics.pressureCompactions, 0), previewTruncations: rows.reduce((sum, row) => sum + row.metrics.previewTruncations, 0),
        prunedEpisodes: rows.filter(row => row.metrics.prunedTaskIds.length > 0).length, stablePromptRuns: rows.reduce((sum, row) => sum + row.metrics.stablePromptRuns, 0), multiRoundRuns: rows.reduce((sum, row) => sum + row.metrics.multiRoundRuns, 0) },
    }
  })
  const primary = bootstrapDelta(manifest, observations, 'baseline', 'full')
  const exploratory = manifest.split === 'formal' ? {
    contextMinusBaseline: bootstrapDelta(manifest, observations, 'baseline', 'context'),
    fullMinusPrompt: bootstrapDelta(manifest, observations, 'prompt', 'full'),
    promptMinusBaseline: bootstrapDelta(manifest, observations, 'baseline', 'prompt'),
    fullMinusContext: bootstrapDelta(manifest, observations, 'context', 'full'),
  } : null
  const pairs = manifest.tasks.map(task => ({ id: task.id, family: task.family, arms: Object.fromEntries(arms.map(arm => [arm.arm, observations.filter(record => record.taskId === task.id && record.arm === arm.arm).map(record => ({ repeat: record.repeat, reliableSuccess: reliableSuccess(record), status: record.status, groups: record.acceptanceGroups }))])),
    baselineFull: Array.from({ length: repeatsForV2Split(manifest.split) }, (_, repeat) => {
      const baseline = observations.find(record => record.taskId === task.id && record.repeat === repeat && record.arm === 'baseline')
      const full = observations.find(record => record.taskId === task.id && record.repeat === repeat && record.arm === 'full')
      if (!baseline || !full) return 'missing'
      return reliableSuccess(baseline) ? reliableSuccess(full) ? 'both-success' : 'baseline-only' : reliableSuccess(full) ? 'full-only' : 'both-failed'
    }),
  }))
  return { protocol: manifest.protocol, manifestDigest: manifest.digest, observationsDigest: sha(observations.map(record => stable(record)).join('\n')),
    split: manifest.split, planned: manifest.episodes.length, executed: observations.length, incomplete: missing.length > 0 || invalid.length > 0,
    missing, invalid, arms, primary, exploratory, pairs,
    measurementLimits: ['Policy/parameter rejection has no structured event subtype in the current Harness; null means not measurable, never zero.', 'A failed test command is counted as a tool error but cannot be reliably separated from an unexpected command error without a structured check marker.', 'A provider call interrupted before usage is durable may cost more than the token-derived estimate; the runner stops the batch after an infrastructure or evidence failure.'],
    interpretation: missing.length || invalid.length ? 'incomplete' : manifest.split === 'development' ? 'development-only' : manifest.split === 'calibration' ? 'calibration-only' : !primary.complete ? 'incomplete' : primary.estimate! >= 0.10 && primary.lower95! > 0 ? 'supported-improvement' : 'no-supported-improvement',
    thresholdClaimSupported: manifest.split === 'formal' && primary.complete && primary.lower95! >= 0.10 }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length !== 6 || args[0] !== '--manifest' || args[2] !== '--runs' || args[4] !== '--output') throw new Error('usage: eval:v2-report --manifest FILE --runs JSONL --output FILE')
  const manifest = JSON.parse(await fs.readFile(args[1]!, 'utf8')) as V2Manifest
  const records = (await fs.readFile(args[3]!, 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as V2Observation)
  const report = reportV2(manifest, records)
  await fs.writeFile(args[5]!, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
  console.log(JSON.stringify({ output: args[5], planned: report.planned, executed: report.executed, incomplete: report.incomplete, primary: report.primary }))
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
