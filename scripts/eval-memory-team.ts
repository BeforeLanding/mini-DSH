import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import dotenv from 'dotenv'
import { createDeepSeekAdapter, normalizeUsage } from '../src/models/deepseek.js'
import { memoryHash, sha256 } from '../src/core/memory-contracts.js'
import { groupPolicy } from '../src/core/task-group-budget.js'
import { resolveBudget } from '../src/core/budget.js'
import {
  MEMORY_TEAM_AMOUNT, MEMORY_TEAM_ARMS, MEMORY_TEAM_BUDGET, MEMORY_TEAM_DELEGATION, MEMORY_TEAM_MODEL, MEMORY_TEAM_PRICE,
  MEMORY_TEAM_PROTOCOL, assertFrozenConfiguration, buildMemoryTeamSchedule, loadMemoryTeamData, memorySnapshotDigest,
  validateMemoryTeamSchedule,
} from './memory-team-eval-plan.js'
import type { MemoryTeamArm, MemoryTeamData, MemoryTeamManifest } from './memory-team-eval-plan.js'
import { createFrozenMemorySnapshot, materializeWorkflowWorkspace, runMemoryTeamEpisode, validateEpisodeAssembly } from './memory-team-executor.js'
import type { EpisodeAdapter, EpisodeResult } from './memory-team-executor.js'
import { verifyMemoryTeamWorkflow } from './memory-team-verifier.js'
import { usageCost } from './memory-team-stats.js'
export type { MemoryTeamArm, MemoryTeamManifest } from './memory-team-eval-plan.js'

const repository = fileURLToPath(new URL('../../', import.meta.url))
function git(args: string[]) { return execFileSync('git', args, { cwd: repository, encoding: 'utf8', windowsHide: true }).trim() }
async function codeDigest() {
  const files = [...new Set(git(['ls-files', '-co', '--exclude-standard', '--', 'src', 'scripts', 'plugins.config.ts', 'package.json', 'pnpm-lock.yaml']).split('\n').filter(Boolean))].sort()
  const entries = await Promise.all(files.map(async file => [file, memoryHash((await fs.readFile(path.join(repository, file), 'utf8')).replace(/\r\n/g, '\n'))]))
  return memoryHash(JSON.stringify(entries))
}
function manifestDigest(manifest: Omit<MemoryTeamManifest, 'digest'> | MemoryTeamManifest) { const { digest: _digest, ...body } = manifest as MemoryTeamManifest; return memoryHash(JSON.stringify(body)) }
const commonFields = (manifest: MemoryTeamManifest) => JSON.stringify({
  model: manifest.model, price: manifest.price, source: manifest.source, taskGroupPolicy: manifest.taskGroupPolicy, runBudget: manifest.runBudget,
  delegationLimits: manifest.delegationLimits, amount: manifest.amount, experienceDigest: manifest.experienceDigest, workflowDigest: manifest.workflowDigest,
  workflowIds: manifest.workflowIds, memorySnapshotDigest: manifest.memorySnapshotDigest, memoryProjectId: manifest.memoryProjectId, episodes: manifest.episodes,
})
export async function prepareMemoryTeamManifests(): Promise<MemoryTeamManifest[]> {
  const data = await loadMemoryTeamData(), source = { commit: git(['rev-parse', 'HEAD']), codeDigest: await codeDigest() }
  if (memorySnapshotDigest(data.memorySnapshot) !== data.memorySnapshot.digest) throw new Error('memory snapshot digest is not self-consistent')
  const shared = {
    version: 2 as const, protocol: MEMORY_TEAM_PROTOCOL, phase: 'development' as const, source,
    model: MEMORY_TEAM_MODEL, price: MEMORY_TEAM_PRICE, taskGroupPolicy: MEMORY_TEAM_BUDGET.taskGroup, runBudget: MEMORY_TEAM_BUDGET.run,
    delegationLimits: MEMORY_TEAM_DELEGATION, amount: MEMORY_TEAM_AMOUNT, postCompactionPrune: false as const,
    experienceDigest: data.experienceDigest, workflowDigest: data.workflowDigest, workflowIds: data.workflowIds,
    memorySnapshotDigest: data.memorySnapshot.digest, memoryProjectId: data.memorySnapshot.projectId,
    preparationAccessibleToAll: true as const, paidExecutionAuthorized: false as const,
    episodes: buildMemoryTeamSchedule(data.workflowIds), plannedEpisodes: 16 as const,
  }
  return MEMORY_TEAM_ARMS.map(arm => {
    const body: Omit<MemoryTeamManifest, 'digest'> = {
      ...shared, arm, memory: arm.endsWith('memory-on'), team: arm.startsWith('team-'),
      source: { ...shared.source }, model: { ...shared.model }, price: { ...shared.price },
      taskGroupPolicy: { ...shared.taskGroupPolicy }, runBudget: { ...shared.runBudget }, delegationLimits: { ...shared.delegationLimits }, amount: { ...shared.amount },
      workflowIds: [...shared.workflowIds], episodes: shared.episodes.map(episode => ({ ...episode })),
    }
    return { ...body, digest: manifestDigest(body) }
  })
}

async function verifierSelfTest(workflow: MemoryTeamData['workflows'][number], data: MemoryTeamData, root: string) {
  const workspace = path.join(root, `${workflow.id}-oracle`)
  await materializeWorkflowWorkspace(workflow, data, workspace)
  const untouched = await verifyMemoryTeamWorkflow(workflow, workspace)
  if (untouched.passed) throw new Error(`verifier accepts an untouched workspace for ${workflow.id}`)
  if (workflow.id === 'W02') await fs.writeFile(path.join(workspace, 'docs/ENTRY.md'), workflow.targetFiles['docs/ENTRY.md']!, 'utf8')
  const answers: Record<string, unknown> = {
    W01: { verificationPath: 'docs/VERIFY.md', verificationCommand: 'node check.mjs', sourcePath: 'src/value.mjs' },
    W02: { currentEntry: 'src/new.mjs', historicalApplicable: false },
    W03: { modules: ['src/parse.mjs', 'src/format.mjs'], boundaries: { parse: 'empty or non-string input reaches trim', format: 'null and nested objects need an explicit string contract' }, testsRan: false },
    W04: { nanAccepted: true, smallestCheck: 'Number.isNaN(value)', historicalHelps: false },
  }
  await fs.writeFile(path.join(workspace, 'answer.json'), `${JSON.stringify(answers[workflow.id])}\n`, 'utf8')
  const oracle = await verifyMemoryTeamWorkflow(workflow, workspace)
  if (!oracle.passed) throw new Error(`verifier rejects a correct answer for ${workflow.id}: ${oracle.checks.filter(check => !check.passed).map(check => check.id).join(', ')}`)
}

export async function validateMemoryTeamManifests(manifests: MemoryTeamManifest[], { dryRun = true }: { dryRun?: boolean } = {}) {
  const data = await loadMemoryTeamData(), currentCodeDigest = await codeDigest()
  if (manifests.length !== 4 || new Set(manifests.map(manifest => manifest.arm)).size !== 4 || MEMORY_TEAM_ARMS.some(arm => !manifests.some(manifest => manifest.arm === arm))) throw new Error('exactly four independent memory/team arms are required')
  if (manifests.some(manifest => commonFields(manifest) !== commonFields(manifests[0]!))) throw new Error('arm model, source, data, price, budget and amount cap must match')
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-team-validate-'))
  try {
    for (const manifest of manifests) {
      if (manifest.version !== 2 || manifest.protocol !== MEMORY_TEAM_PROTOCOL || manifest.phase !== 'development' || manifest.digest !== manifestDigest(manifest) ||
        !sha256(manifest.source.codeDigest) || !/^[a-f0-9]{40}$/.test(manifest.source.commit) || manifest.source.codeDigest !== currentCodeDigest ||
        manifest.memory !== manifest.arm.endsWith('memory-on') || manifest.team !== manifest.arm.startsWith('team-') || manifest.postCompactionPrune !== false ||
        manifest.experienceDigest !== data.experienceDigest || manifest.workflowDigest !== data.workflowDigest ||
        JSON.stringify(manifest.workflowIds) !== JSON.stringify(data.workflowIds) || manifest.memorySnapshotDigest !== data.memorySnapshot.digest ||
        manifest.memoryProjectId !== data.memorySnapshot.projectId || manifest.plannedEpisodes !== 16) throw new Error(`invalid, stale or mismatched manifest: ${manifest.arm}`)
      assertFrozenConfiguration(manifest)
      groupPolicy(manifest.taskGroupPolicy); resolveBudget(manifest.runBudget)
      if (!Number.isFinite(manifest.amount.perEpisodeUsd) || manifest.amount.perEpisodeUsd <= 0 || !Number.isFinite(manifest.amount.batchUsd) || manifest.amount.batchUsd < manifest.amount.perEpisodeUsd * 16) throw new Error('invalid development amount cap')
    }
    validateMemoryTeamSchedule(manifests[0]!.episodes, data.workflowIds)
    if (dryRun) {
      const snapshotRoot = path.join(temporary, 'memory-snapshot')
      const snapshotDigest = await createFrozenMemorySnapshot(data.memorySnapshot, snapshotRoot)
      if (snapshotDigest !== data.memorySnapshot.digest) throw new Error('frozen memory snapshot digest changed while seeding')
      for (const workflow of data.workflows) await verifierSelfTest(workflow, data, temporary)
      let dryRunEpisodes = 0
      for (const episode of manifests[0]!.episodes) {
        const workflow = data.workflows.find(item => item.id === episode.workflowId)
        if (!workflow) throw new Error(`schedule references unknown workflow: ${episode.workflowId}`)
        const manifest = manifests.find(item => item.arm === episode.arm)
        if (!manifest) throw new Error(`schedule references unknown arm: ${episode.arm}`)
        const dry = await validateEpisodeAssembly({ workflow, data, manifest, arm: episode.arm, root: temporary, memorySnapshotDirectory: snapshotRoot })
        if (!dry.verifierRejectsUntouched) throw new Error(`verifier does not reject the initial workspace: ${episode.id}`)
        dryRunEpisodes += 1
      }
      if (dryRunEpisodes !== 16) throw new Error('dry run did not cover all 16 episodes')
    }
  } finally { await fs.rm(temporary, { recursive: true, force: true }) }
  return {
    valid: true, protocol: MEMORY_TEAM_PROTOCOL, arms: manifests.map(manifest => manifest.arm), workflowsPerArm: data.workflowIds.length,
    plannedDevelopmentEpisodes: 16, dryRunEpisodes: dryRun ? 16 : 0, providerCalls: 0, paidExecutionAuthorized: false,
    model: manifests[0]!.model.requested, price: manifests[0]!.price, amount: manifests[0]!.amount,
    limitation: 'Development validation only; no effect scores or paid execution path is claimed by this report.',
  }
}

export async function freezeMemoryTeamManifests(directory: string) {
  if (git(['status', '--porcelain'])) throw new Error('freeze requires a clean repository')
  const manifests = await prepareMemoryTeamManifests(); await validateMemoryTeamManifests(manifests)
  const target = path.resolve(directory); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.mkdir(target)
  for (const manifest of manifests) await fs.writeFile(path.join(target, `${manifest.arm}.manifest.json`), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  return target
}

async function loadManifests(directory: string) {
  return Promise.all(MEMORY_TEAM_ARMS.map(async arm => JSON.parse(await fs.readFile(path.join(directory, `${arm}.manifest.json`), 'utf8')) as MemoryTeamManifest))
}

interface RunRecord {
  episodeId: string; workflowId: string; arm: MemoryTeamArm; status: string; reliableCompletion: boolean; accepted: boolean; fatal: boolean
  tokens: number; costUsd: number; requests: number; tools: number; wallDurationMs: number; activeDurationMs: number
  prepareTokens: number; goalTokens: number; childTokens: number; summaryTokens: number; retryRequests: number; retryFailedTokens: number; retryCostUsd: number
  memoryQueries: number; memoryHits: number; memoryFiltered: Record<string, number>; delegationBatches: number; childSessions: number; delegationStatuses: Record<string, number>
  usageUnknown: boolean; overrun: boolean; error?: string
}
function recordOf(result: EpisodeResult): RunRecord {
  const prepare = result.accounting.phases.find(phase => phase.phase === 'prepare')
  const goal = result.accounting.phases.find(phase => phase.phase === 'goal')
  return {
    episodeId: result.episode.id, workflowId: result.workflowId, arm: result.arm, status: result.status, reliableCompletion: result.reliableCompletion,
    accepted: result.acceptance.passed, fatal: result.fatal, tokens: result.accounting.total.totalTokens, costUsd: result.accounting.total.costUsd,
    requests: result.accounting.modelRequests, tools: result.accounting.tools, wallDurationMs: result.wallDurationMs, activeDurationMs: result.accounting.activeDurationMs,
    prepareTokens: prepare?.total.totalTokens ?? 0, goalTokens: goal?.total.totalTokens ?? 0, childTokens: result.accounting.child.totalTokens,
    summaryTokens: result.accounting.summary.totalTokens, retryRequests: result.accounting.retryRequests, retryFailedTokens: result.accounting.retryFailedTokens,
    retryCostUsd: result.accounting.retryCostUsd, memoryQueries: result.accounting.memory.queries, memoryHits: result.accounting.memory.hits,
    memoryFiltered: result.accounting.memory.filtered, delegationBatches: result.accounting.delegation.batches, childSessions: result.accounting.delegation.childSessions,
    delegationStatuses: result.accounting.delegation.statuses, usageUnknown: result.accounting.unknownUsage || result.guard.usageUnknown, overrun: result.accounting.overrun || result.guard.overrun,
    ...(result.error ? { error: result.error } : {}),
  }
}
function sum(records: RunRecord[], select: (record: RunRecord) => number) { return records.reduce((total, record) => total + select(record), 0) }
function armSummary(records: RunRecord[]) {
  return {
    episodes: records.length, accepted: records.filter(record => record.accepted).length, reliable: records.filter(record => record.reliableCompletion).length,
    tokens: sum(records, record => record.tokens), costUsd: sum(records, record => record.costUsd), requests: sum(records, record => record.requests), tools: sum(records, record => record.tools),
    prepareTokens: sum(records, record => record.prepareTokens), goalTokens: sum(records, record => record.goalTokens), childTokens: sum(records, record => record.childTokens),
    summaryTokens: sum(records, record => record.summaryTokens), retryRequests: sum(records, record => record.retryRequests), retryFailedTokens: sum(records, record => record.retryFailedTokens),
    retryCostUsd: sum(records, record => record.retryCostUsd), memoryQueries: sum(records, record => record.memoryQueries), memoryHits: sum(records, record => record.memoryHits),
    delegationBatches: sum(records, record => record.delegationBatches), childSessions: sum(records, record => record.childSessions),
    activeDurationMs: sum(records, record => record.activeDurationMs), wallDurationMs: sum(records, record => record.wallDurationMs),
    usageUnknown: records.some(record => record.usageUnknown), overrun: records.some(record => record.overrun),
  }
}
export function aggregateMemoryTeamRuns(records: RunRecord[]) {
  const arms = Object.fromEntries(MEMORY_TEAM_ARMS.map(arm => [arm, armSummary(records.filter(record => record.arm === arm))]))
  const workflows = Object.fromEntries([...new Set(records.map(record => record.workflowId))].map(workflowId => [workflowId, Object.fromEntries(MEMORY_TEAM_ARMS.map(arm => [arm, armSummary(records.filter(record => record.workflowId === workflowId && record.arm === arm))]))]))
  const pair = (workflowId: string, baselineArm: MemoryTeamArm, treatmentArm: MemoryTeamArm) => {
    const baseline = records.find(record => record.workflowId === workflowId && record.arm === baselineArm), treatment = records.find(record => record.workflowId === workflowId && record.arm === treatmentArm)
    if (!baseline || !treatment) return undefined
    return {
      workflowId, baseline: baselineArm, treatment: treatmentArm,
      benefit: { acceptedDelta: Number(treatment.accepted) - Number(baseline.accepted), reliableDelta: Number(treatment.reliableCompletion) - Number(baseline.reliableCompletion) },
      overhead: {
        tokenDelta: treatment.tokens - baseline.tokens, costUsdDelta: treatment.costUsd - baseline.costUsd, requestDelta: treatment.requests - baseline.requests,
        wallMsDelta: treatment.wallDurationMs - baseline.wallDurationMs, childTokens: treatment.childTokens, summaryTokens: treatment.summaryTokens,
        retryFailedTokens: treatment.retryFailedTokens, memoryQueries: treatment.memoryQueries, memoryHits: treatment.memoryHits,
      },
    }
  }
  const comparisons: unknown[] = []
  for (const workflowId of Object.keys(workflows)) {
    for (const items of [
      pair(workflowId, 'single-memory-off', 'single-memory-on'), pair(workflowId, 'team-memory-off', 'team-memory-on'),
      pair(workflowId, 'single-memory-off', 'team-memory-off'), pair(workflowId, 'single-memory-on', 'team-memory-on'),
    ]) if (items) comparisons.push(items)
  }
  return {
    episodes: records.length, planned: 16, accepted: records.filter(record => record.accepted).length, reliable: records.filter(record => record.reliableCompletion).length,
    fatal: records.filter(record => record.fatal).length, usageUnknown: records.some(record => record.usageUnknown), overrun: records.some(record => record.overrun),
    total: {
      tokens: sum(records, record => record.tokens), costUsd: sum(records, record => record.costUsd), requests: sum(records, record => record.requests), tools: sum(records, record => record.tools),
      prepareTokens: sum(records, record => record.prepareTokens), goalTokens: sum(records, record => record.goalTokens), childTokens: sum(records, record => record.childTokens),
      summaryTokens: sum(records, record => record.summaryTokens), retryFailedTokens: sum(records, record => record.retryFailedTokens), retryCostUsd: sum(records, record => record.retryCostUsd),
      memoryQueries: sum(records, record => record.memoryQueries), memoryHits: sum(records, record => record.memoryHits), delegationBatches: sum(records, record => record.delegationBatches),
      activeDurationMs: sum(records, record => record.activeDurationMs), wallDurationMs: sum(records, record => record.wallDurationMs),
    },
    arms, workflows, comparisons,
    limitation: 'Four development workflows, one episode per cell: this is an exploratory pairing check, not a significance or generalization claim. Costs use the frozen peak price snapshot.',
  }
}

async function executeBatch(manifestDirectory: string, evidenceRoot: string, maxUsd: number) {
  const manifests = await loadManifests(manifestDirectory)
  const data = await loadMemoryTeamData()
  if (git(['status', '--porcelain'])) throw new Error('paid run requires a clean repository')
  const head = git(['rev-parse', 'HEAD'])
  if (manifests.some(manifest => manifest.source.commit !== head)) throw new Error('paid run requires HEAD to match the frozen source commit; re-freeze after source or docs changes')
  await validateMemoryTeamManifests(manifests, { dryRun: false })
  if (!Number.isFinite(maxUsd) || maxUsd <= 0) throw new Error('--max-usd must be a positive finite amount')
  if (maxUsd > manifests[0]!.amount.batchUsd) throw new Error(`--max-usd exceeds the frozen batch cap of $${manifests[0]!.amount.batchUsd.toFixed(2)}`)
  if (maxUsd < manifests[0]!.amount.probeReserveUsd + manifests[0]!.amount.perEpisodeUsd) throw new Error('--max-usd cannot reserve the probe and one complete episode')
  if (await fs.stat(evidenceRoot).catch(() => undefined)) throw new Error(`evidence root already exists: ${evidenceRoot}`)
  dotenv.config({ quiet: true })
  if (!process.env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY is required for a paid memory-team batch')
  const model = manifests[0]!.model
  const rawAdapter = createDeepSeekAdapter({ baseUrl: model.baseUrl, models: [model.providerModel], thinking: model.thinking, contextWindowTokens: model.window })
  const adapter: EpisodeAdapter = { provider: 'deepseek', model: model.providerModel, capabilities: rawAdapter.capabilities, chat: rawAdapter.chat }
  if (`${adapter.provider}/${adapter.model}` !== model.requested) throw new Error('adapter selection does not match the frozen model')
  await fs.mkdir(evidenceRoot, { recursive: true })
  for (const manifest of manifests) await fs.writeFile(path.join(evidenceRoot, `${manifest.arm}.manifest.json`), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
  const startedAt = new Date().toISOString()
  await fs.writeFile(path.join(evidenceRoot, 'authorization.json'), `${JSON.stringify({
    authorizedMaxUsd: maxUsd, frozenBatchCapUsd: manifests[0]!.amount.batchUsd, perEpisodeCapUsd: manifests[0]!.amount.perEpisodeUsd,
    sourceCommit: head, model: model.requested, echoedModel: model.echoed, price: manifests[0]!.price, startedAt,
  }, null, 2)}\n`, { flag: 'wx' })
  const runLog = path.join(evidenceRoot, 'runs.jsonl')
  await fs.writeFile(runLog, '', { flag: 'wx' })
  let spentUsd: number = manifests[0]!.amount.probeReserveUsd, stopped = false, stopReason = ''
  try {
    const response = await fetch(`${model.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST', headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: model.providerModel, max_tokens: 16, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: 'reply with the single word: ok' }] }),
      signal: AbortSignal.timeout(60_000),
    })
    if (!response.ok) throw new Error(`model probe failed: HTTP ${response.status}`)
    const direct = await response.json() as { model?: string; usage?: unknown }
    if (direct.model !== model.echoed || !direct.usage) throw new Error(`model probe mismatch: expected ${model.echoed}, observed ${String(direct.model)}`)
    const streamed = await rawAdapter.chat({ model: model.providerModel, maxOutputTokens: 1024, messages: [{ role: 'user', content: 'reply with the single word: ok' }] })
    if (streamed.usage?.source !== 'provider' || streamed.complete === false) throw new Error('streaming model probe returned no complete provider usage')
    const directUsage = normalizeUsage(direct.usage)
    const probeCost = usageCost(streamed.usage, manifests[0]!.price) + (directUsage ? usageCost(directUsage, manifests[0]!.price) : 0)
    spentUsd = probeCost
    await fs.writeFile(path.join(evidenceRoot, 'probe.json'), `${JSON.stringify({ requestedModel: model.providerModel, echoedModel: direct.model, directUsage: direct.usage, streamedUsage: streamed.usage, probeCostUsd: probeCost }, null, 2)}\n`, { flag: 'wx' })
  } catch (error) {
    await fs.writeFile(path.join(evidenceRoot, 'probe-error.json'), `${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`, { flag: 'wx' })
    throw error
  }
  const snapshotDirectory = path.join(evidenceRoot, 'memory-snapshot')
  const snapshotDigest = await createFrozenMemorySnapshot(data.memorySnapshot, snapshotDirectory)
  if (snapshotDigest !== manifests[0]!.memorySnapshotDigest) throw new Error('memory snapshot digest changed after freeze')
  const manifestsByArm = new Map(manifests.map(manifest => [manifest.arm, manifest]))
  const records: RunRecord[] = []
  for (const [index, episode] of manifests[0]!.episodes.entries()) {
    if (spentUsd + manifests[0]!.amount.perEpisodeUsd > maxUsd) { stopped = true; stopReason = 'amount_cap_before_complete_episode'; break }
    const workflow = data.workflows.find(item => item.id === episode.workflowId)
    const manifest = manifestsByArm.get(episode.arm)
    if (!workflow || !manifest) throw new Error(`invalid frozen episode: ${episode.id}`)
    const episodeDirectory = path.join(evidenceRoot, 'episodes', `${String(index).padStart(3, '0')}-${episode.id}`)
    await fs.mkdir(episodeDirectory, { recursive: true })
    let result: EpisodeResult
    try {
      result = await runMemoryTeamEpisode({ episode, workflow, data, manifest, adapter, episodeRoot: episodeDirectory, memorySnapshotDirectory: snapshotDirectory })
    } catch (error) {
      await fs.writeFile(path.join(episodeDirectory, 'error.json'), `${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`, { flag: 'wx' })
      throw error
    }
    const record = recordOf(result)
    await fs.writeFile(path.join(episodeDirectory, 'episode.json'), `${JSON.stringify({ ...result, acceptance: result.acceptance, accounting: result.accounting }, null, 2)}\n`, { flag: 'wx' })
    await fs.appendFile(runLog, `${JSON.stringify(record)}\n`)
    records.push(record)
    spentUsd += result.guard.spentUsd
    console.log(`${episode.id}: status=${record.status} accepted=${record.accepted} tokens=${record.tokens} cost≈$${result.guard.spentUsd.toFixed(4)} spent≈$${spentUsd.toFixed(4)}`)
    if (result.guard.usageUnknown || result.fatal) { stopped = true; stopReason = result.guard.usageUnknown ? 'usage_unknown' : 'infrastructure_or_evidence_error'; break }
    if (spentUsd > maxUsd) { stopped = true; stopReason = 'amount_cap_exceeded_after_provider_usage'; break }
  }
  const report = {
    ...aggregateMemoryTeamRuns(records), stopped, stopReason, startedAt, finishedAt: new Date().toISOString(),
    probeCostUsd: spentUsd - records.reduce((sum, record) => sum + record.costUsd, 0), spentUsdEstimate: spentUsd, authorizedMaxUsd: maxUsd,
    sourceCommit: head, evidenceRoot, costLedgerMethod: 'provider usage from the task-group ledger; not a provider invoice',
  }
  await fs.writeFile(path.join(evidenceRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
  console.log(JSON.stringify({ evidenceRoot, executed: records.length, planned: 16, accepted: report.accepted, reliable: report.reliable, spentUsdEstimate: spentUsd, stopReason }))
  if (records.length !== 16 || report.fatal || stopped) process.exitCode = 1
  return report
}

async function reportEvidence(evidenceRoot: string) {
  const records = (await fs.readFile(path.join(evidenceRoot, 'runs.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as RunRecord)
  const report = aggregateMemoryTeamRuns(records)
  console.log(JSON.stringify(report, null, 2))
  return report
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length === 2 && args[0] === '--freeze' && args[1]) console.log(await freezeMemoryTeamManifests(args[1]))
  else if (args.length === 2 && args[0] === '--validate-only' && args[1]) console.log(JSON.stringify(await validateMemoryTeamManifests(await loadManifests(args[1])), null, 2))
  else if (args.length === 6 && args[0] === '--execute' && args[2] === '--evidence-root' && args[4] === '--max-usd') await executeBatch(args[1]!, path.resolve(args[3]!), Number(args[5]))
  else if (args.length === 2 && args[0] === '--report' && args[1]) await reportEvidence(args[1])
  else throw new Error('usage: eval-memory-team --freeze <new-directory> | --validate-only <manifest-directory> | --execute <manifest-directory> --evidence-root <new-directory> --max-usd <cap> | --report <evidence-root>')
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
