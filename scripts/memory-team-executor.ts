import fs from 'node:fs/promises'
import path from 'node:path'
import { createHarness } from '../src/app/create-harness.js'
import { JsonlStore, decodeLog } from '../src/core/event-store.js'
import type { Adapter, SessionEvent } from '../src/core/contracts.js'
import type { BudgetPolicy, Counters } from '../src/core/budget.js'
import { estimateInput } from '../src/core/token-estimator.js'
import { ModelNotDispatchedError } from '../src/core/model-dispatch.js'
import { ModelStreamError } from '../src/core/model-error.js'
import { MemoryStore } from '../src/core/memory-store.js'
import { memoryDigest } from '../src/core/memory-contracts.js'
import { MEMORY_TEAM_PROTOCOL, memorySourceArtifact } from './memory-team-eval-plan.js'
import type { MemorySnapshot, MemoryTeamArm, MemoryTeamEpisode, MemoryTeamManifest, MemoryTeamData } from './memory-team-eval-plan.js'
import { deriveMemoryTeamAccounting, usageCost } from './memory-team-stats.js'
import type { MemoryTeamAccounting, Price } from './memory-team-stats.js'
import { verifyMemoryTeamWorkflow } from './memory-team-verifier.js'
import type { VerifierResult } from './memory-team-verifier.js'

export const PREPARE_PROMPT = 'Preparation phase. Read .memory-team/preparation.json and the project files it references. Write a concise evidence note to PREPARE.md. Do not modify any other file and do not write answer.json yet.'
export const WORKSPACE_INFRASTRUCTURE = ['.mini-dsh/', '.memory-team/'] as const

export interface EpisodeAdapter extends Adapter { provider: string; model: string }
export interface EpisodeGuardSnapshot { requests: number; tokens: number; spentUsd: number; usageUnknown: boolean; overrun: boolean; elapsedMs: number }
export interface EpisodeGuard {
  adapter: EpisodeAdapter
  snapshot(): EpisodeGuardSnapshot
}
// One guard covers prepare, goal, children, summaries and retries. Requests,
// tokens, wall time and dollars are hard stops before the next provider call.
export function createEpisodeAmountGuard(delegate: Adapter['chat'], options: {
  provider: string; model: string; capabilities?: Adapter['capabilities']
  maxModelRequests: number; maxTotalTokens: number; maxWallDurationMs: number; maxUsd: number; price: Price
  now?: () => number
}): EpisodeGuard {
  if (!Number.isSafeInteger(options.maxModelRequests) || options.maxModelRequests < 1) throw new Error('episode request cap must be positive')
  if (!Number.isSafeInteger(options.maxTotalTokens) || options.maxTotalTokens < 1) throw new Error('episode token cap must be positive')
  if (!Number.isSafeInteger(options.maxWallDurationMs) || options.maxWallDurationMs < 1) throw new Error('episode wall cap must be positive')
  if (!Number.isFinite(options.maxUsd) || options.maxUsd <= 0) throw new Error('episode amount cap must be positive')
  const now = options.now ?? Date.now, startedAt = now()
  let requests = 0, tokens = 0, spentUsd = 0, usageUnknown = false, overrun = false
  const ceiling = (request: Parameters<Adapter['chat']>[0]) => Math.max(1, request.maxOutputTokens ?? 16_384)
  const chat: Adapter['chat'] = async request => {
    const elapsedMs = now() - startedAt
    if (usageUnknown) throw new ModelNotDispatchedError('episode has unknown provider usage; no further call made', 'usage_unknown')
    if (overrun) throw new ModelNotDispatchedError('episode budget already exceeded; no further call made', 'other_limit')
    if (elapsedMs >= options.maxWallDurationMs) throw new ModelNotDispatchedError('episode wall deadline reached before dispatch', 'other_limit')
    if (requests + 1 > options.maxModelRequests) throw new ModelNotDispatchedError('episode request cap reached', 'request_limit')
    const inputEstimate = estimateInput(request), outputEstimate = ceiling(request), reserveTokens = inputEstimate + outputEstimate
    if (tokens + reserveTokens > options.maxTotalTokens) throw new ModelNotDispatchedError('episode token cap cannot reserve the next request', 'other_limit')
    const reserveUsd = (inputEstimate * options.price.inputPerMillion + outputEstimate * options.price.outputPerMillion) / 1_000_000 * 1.1
    if (spentUsd + reserveUsd > options.maxUsd) throw new ModelNotDispatchedError('episode amount cap cannot reserve the next request', 'amount_limit')
    requests += 1
    try {
      const response = await delegate(request)
      if (response.usage?.source === 'provider' && !response.usage.uncertain) {
        tokens += response.usage.totalTokens; spentUsd += usageCost(response.usage, options.price)
        if (tokens > options.maxTotalTokens || spentUsd > options.maxUsd) overrun = true
      } else usageUnknown = true
      return response
    } catch (error) {
      if (error instanceof ModelNotDispatchedError) { requests -= 1; throw error }
      const partial = error instanceof ModelStreamError ? error.partial.usage : undefined
      if (partial?.source === 'provider' && !partial.uncertain) {
        tokens += partial.totalTokens; spentUsd += usageCost(partial, options.price)
        if (tokens > options.maxTotalTokens || spentUsd > options.maxUsd) overrun = true
      } else usageUnknown = true
      throw error
    }
  }
  return {
    adapter: { provider: options.provider, model: options.model, capabilities: options.capabilities, chat },
    snapshot: () => ({ requests, tokens, spentUsd, usageUnknown, overrun, elapsedMs: now() - startedAt }),
  }
}

function safeRelative(file: string) {
  const normalized = path.posix.normalize(file)
  if (path.isAbsolute(file) || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) throw new Error(`unsafe workspace path: ${file}`)
  return normalized
}
async function writeFile(root: string, file: string, content: string) {
  const target = path.join(root, safeRelative(file))
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, content, { flag: 'wx' })
}
export async function materializeWorkflowWorkspace(workflow: MemoryTeamData['workflows'][number], data: MemoryTeamData, directory: string) {
  await fs.mkdir(directory, { recursive: false })
  for (const [file, content] of Object.entries(workflow.initialFiles)) await writeFile(directory, file, content)
  const records = data.experience.filter(record => record.workflowId === workflow.id).map(record => ({ key: record.key, kind: record.kind, sourcePath: record.sourcePath, content: record.content }))
  await writeFile(directory, '.memory-team/preparation.json', `${JSON.stringify({ version: 1, workflowId: workflow.id, records }, null, 2)}\n`)
}

// Seed once per batch, then copy the exact directory into each memory-on episode.
// Anchors are relative, so the same records are revalidated against each workspace.
export async function createFrozenMemorySnapshot(snapshot: MemorySnapshot, directory: string) {
  await fs.mkdir(directory, { recursive: true })
  const store = await MemoryStore.open({ directory, workspace: directory, projectId: snapshot.projectId })
  try {
    for (const record of snapshot.records) {
      const artifact = memorySourceArtifact(record)
      if (artifact.sha256 !== record.sources[0]?.artifactSha256) throw new Error(`memory snapshot artifact digest mismatch: ${record.workflowId}`)
      const sourceDirectory = path.join(directory, snapshot.projectId, 'sources')
      await fs.mkdir(sourceDirectory, { recursive: true, mode: 0o700 })
      await fs.writeFile(path.join(sourceDirectory, `${artifact.sha256}.json`), artifact.bytes, { flag: 'wx', mode: 0o600 })
      const proposed = await store.propose(`seed-${record.workflowId}`, {
        kind: record.kind, key: record.key, title: record.title, content: record.content, tags: record.tags, anchors: record.anchors, sources: record.sources,
      })
      await store.approve(`approve-${record.workflowId}`, proposed.id, proposed.revision, memoryDigest(proposed))
    }
    const stored = await store.records()
    const approved = stored.filter(record => record.state === 'approved')
    if (approved.length !== snapshot.records.length) throw new Error('frozen memory snapshot did not approve every record')
    for (const expected of snapshot.records) {
      const actual = approved.find(record => record.key === expected.key)
      if (!actual || actual.content !== expected.content || JSON.stringify(actual.anchors) !== JSON.stringify(expected.anchors) ||
        JSON.stringify(actual.sources) !== JSON.stringify(expected.sources)) throw new Error(`frozen memory snapshot differs from data: ${expected.workflowId}`)
    }
  } finally { await store.close() }
  return snapshot.digest
}

export async function copyMemorySnapshot(snapshotDirectory: string, projectId: string, episodeMemoryDirectory: string) {
  await fs.mkdir(episodeMemoryDirectory, { recursive: true })
  await fs.cp(path.join(snapshotDirectory, projectId), path.join(episodeMemoryDirectory, projectId), { recursive: true, errorOnExist: true, force: false })
}

export interface EpisodeHarnessOptions {
  workflow: MemoryTeamData['workflows'][number]
  arm: MemoryTeamArm
  workspace: string
  memoryDirectory?: string
  teamsDirectory?: string
  manifest: MemoryTeamManifest
  adapter: EpisodeAdapter
}
export async function assembleEpisodeHarness(options: EpisodeHarnessOptions) {
  const memory = options.arm.endsWith('memory-on'), team = options.arm.startsWith('team-')
  return createHarness({
    workspace: options.workspace, profile: 'coding', adapter: options.adapter, autoApprove: true,
    contextLayout: 'live', runtimeClockMode: 'live', taskGroupPolicy: options.manifest.taskGroupPolicy,
    ...(memory ? { memory: { mode: 'recall' as const, directory: options.memoryDirectory!, projectId: options.manifest.memoryProjectId, readOnly: true } } : {}),
    ...(team ? { delegation: { mode: 'read-only' as const, directory: options.teamsDirectory!, limits: options.manifest.delegationLimits } } : {}),
  })
}

async function listSessionEvents(directory: string): Promise<SessionEvent[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error })
  const sessions = entries.filter(entry => entry.isDirectory())
  if (sessions.length !== 1) throw new Error(`expected one root session, found ${sessions.length}`)
  const sessionId = sessions[0]!.name
  return decodeLog(await fs.readFile(path.join(directory, sessionId, 'events.jsonl')), sessionId)
}
async function listChildEvents(directory: string): Promise<SessionEvent[][]> {
  const root = path.join(directory, 'sessions')
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error })
  const result: SessionEvent[][] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const sessionId = entry.name
    try { result.push(decodeLog(await fs.readFile(path.join(root, sessionId, 'events.jsonl')), sessionId)) }
    catch (cause) { throw new Error(`child session log is unreadable: ${sessionId}`, { cause }) }
  }
  return result
}

export interface EpisodePhaseResult {
  phase: 'prepare' | 'goal'; status: string; error?: string; taskId?: string; runId?: string; counters?: Counters; budget?: BudgetPolicy
}
export interface EpisodeResult {
  episode: MemoryTeamEpisode; workflowId: string; arm: MemoryTeamArm
  status: string; reliableCompletion: boolean; fatal: boolean
  phases: EpisodePhaseResult[]; acceptance: VerifierResult; accounting: MemoryTeamAccounting
  guard: EpisodeGuardSnapshot; wallDurationMs: number
  workspace: string; acceptanceCopy: string; sessionDirectory: string; teamsDirectory: string
  memoryDigest?: string; error?: string; startedAt: string; finishedAt: string
}

async function phaseSend(agent: { send(input: string, options?: { budget?: BudgetPolicy }): Promise<string> }, prompt: string, budget: BudgetPolicy) {
  try { await agent.send(prompt, { budget }); return undefined } catch (error) { return error instanceof Error ? error.message : String(error) }
}

export async function runMemoryTeamEpisode(options: {
  episode: MemoryTeamEpisode
  workflow: MemoryTeamData['workflows'][number]
  data: MemoryTeamData
  manifest: MemoryTeamManifest
  adapter: EpisodeAdapter
  episodeRoot: string
  memorySnapshotDirectory?: string
}): Promise<EpisodeResult> {
  const { episode, workflow, data, manifest, episodeRoot } = options
  if (episode.arm !== manifest.arm) throw new Error(`episode arm ${episode.arm} does not match manifest arm ${manifest.arm}`)
  if (episode.workflowId !== workflow.id) throw new Error(`episode workflow ${episode.workflowId} does not match ${workflow.id}`)
  const startedAt = new Date().toISOString(), started = Date.now()
  const workspace = path.join(episodeRoot, 'workspace'), sessionDirectory = path.join(episodeRoot, 'sessions')
  const teamsDirectory = path.join(episodeRoot, 'teams'), memoryDirectory = path.join(episodeRoot, 'memory')
  await fs.mkdir(episodeRoot, { recursive: true })
  await materializeWorkflowWorkspace(workflow, data, workspace)
  if (episode.arm.endsWith('memory-on')) {
    if (!options.memorySnapshotDirectory) throw new Error('memory-on episode requires a frozen memory snapshot')
    await copyMemorySnapshot(options.memorySnapshotDirectory, manifest.memoryProjectId, memoryDirectory)
  }
  const guard = createEpisodeAmountGuard(options.adapter.chat, {
    provider: options.adapter.provider, model: options.adapter.model, capabilities: options.adapter.capabilities,
    maxModelRequests: manifest.runBudget.maxModelRequests!, maxTotalTokens: manifest.runBudget.maxTotalTokens!, maxWallDurationMs: manifest.taskGroupPolicy.maxWallDurationMs,
    maxUsd: manifest.amount.perEpisodeUsd, price: manifest.price,
  })
  const harness = await assembleEpisodeHarness({ workflow, arm: episode.arm, workspace, memoryDirectory, teamsDirectory, manifest, adapter: guard.adapter })
  let store: JsonlStore | undefined
  const phases: EpisodePhaseResult[] = []
  let fatal = false, error: string | undefined
  try {
    const session = harness.root.sessions.create({ source: MEMORY_TEAM_PROTOCOL, episode: episode.id, workflowId: episode.workflowId, arm: episode.arm, memorySnapshot: manifest.memorySnapshotDigest })
    store = await JsonlStore.open(sessionDirectory, session.id)
    harness.root.sessions.attachStore(session.id, store)
    await harness.root.sessions.flush(session.id)
    const agent = harness.root.agents.create({ sessionId: session.id, model: `${options.adapter.provider}/${options.adapter.model}`, loop: harness.root.agentLoop, budget: manifest.runBudget })
    if (harness.capabilityManifest.tools.includes('memory_search') !== episode.arm.endsWith('memory-on')) throw new Error('memory capability does not match arm')
    if (harness.capabilityManifest.tools.includes('delegate_tasks') !== episode.arm.startsWith('team-')) throw new Error('delegation capability does not match arm')
    const prepareError = await phaseSend(agent, PREPARE_PROMPT, manifest.runBudget)
    let state = harness.root.sessions.latestRun(session.id)
    phases.push({ phase: 'prepare', status: state?.status ?? 'error', ...(state ? { taskId: state.taskId, runId: state.runId, counters: state.counters } : {}), ...(prepareError ? { error: prepareError } : {}) })
    if (state?.status !== 'completed') {
      error = prepareError ?? `prepare phase ended with ${state?.status ?? 'no run'}`
    } else {
      const snapshot = guard.snapshot()
      const rootEvents = harness.root.sessions.visibleEvents(session.id)
      const childEvents = await listChildEvents(teamsDirectory)
      const usedTools = rootEvents.filter(event => event.type === 'tool/start').length + childEvents.reduce((sum, events) => sum + events.filter(event => event.type === 'tool/start').length, 0)
      const remainingRequests = manifest.runBudget.maxModelRequests! - snapshot.requests
      const remainingTools = manifest.runBudget.maxToolCalls! - usedTools
      const remainingTokens = manifest.runBudget.maxTotalTokens! - snapshot.tokens
      if (remainingRequests < 1 || remainingTools < 1 || remainingTokens < 1 || snapshot.usageUnknown) {
        error = snapshot.usageUnknown ? 'prepare phase has unknown provider usage' : 'common episode budget exhausted before the goal phase'
        if (snapshot.usageUnknown) fatal = true
      } else {
        const goalBudget: BudgetPolicy = { ...manifest.runBudget, maxModelRequests: remainingRequests, maxToolCalls: remainingTools, maxTotalTokens: remainingTokens }
        const goalError = await phaseSend(agent, workflow.target, goalBudget)
        state = harness.root.sessions.latestRun(session.id)
        phases.push({ phase: 'goal', status: state?.status ?? 'error', budget: goalBudget, ...(state ? { taskId: state.taskId, runId: state.runId, counters: state.counters } : {}), ...(goalError ? { error: goalError } : {}) })
        if (goalError) error = goalError
      }
    }
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause); fatal = true
  } finally {
    try {
      if (store) { await harness.root.sessions.close(); await harness.dispose() } else await harness.dispose()
    } catch (cause) { fatal = true; error ??= cause instanceof Error ? cause.message : String(cause) }
  }
  const rootEvents = await listSessionEvents(sessionDirectory).catch(() => [] as SessionEvent[])
  const childEvents = await listChildEvents(teamsDirectory)
  const accounting = deriveMemoryTeamAccounting(rootEvents, childEvents, manifest.price)
  const guardSnapshot = guard.snapshot()
  if (guardSnapshot.usageUnknown || guardSnapshot.overrun) fatal = fatal || guardSnapshot.usageUnknown
  const acceptanceCopy = path.join(episodeRoot, 'acceptance-copy')
  await fs.cp(workspace, acceptanceCopy, { recursive: true, errorOnExist: true, force: false })
  const acceptance = await verifyMemoryTeamWorkflow(workflow, acceptanceCopy)
  const last = phases.at(-1), finishedAt = new Date().toISOString()
  const reliableCompletion = phases.length === 2 && phases.every(phase => phase.status === 'completed') && acceptance.passed && !guardSnapshot.usageUnknown && !guardSnapshot.overrun
  return {
    episode, workflowId: episode.workflowId, arm: episode.arm, status: last?.status ?? 'error', reliableCompletion, fatal, phases, acceptance, accounting,
    guard: guardSnapshot, wallDurationMs: Date.now() - started, workspace, acceptanceCopy, sessionDirectory, teamsDirectory,
    ...(episode.arm.endsWith('memory-on') ? { memoryDigest: manifest.memorySnapshotDigest } : {}),
    ...(error ? { error } : {}), startedAt, finishedAt,
  }
}

export interface DryRunResult { workflowId: string; arm: MemoryTeamArm; workspace: string; memoryProjectId?: string; tools: string[]; verifierRejectsUntouched: boolean }
export async function validateEpisodeAssembly(options: {
  workflow: MemoryTeamData['workflows'][number]; data: MemoryTeamData; manifest: MemoryTeamManifest; arm: MemoryTeamArm; root: string; memorySnapshotDirectory: string
}): Promise<DryRunResult> {
  if (options.arm !== options.manifest.arm) throw new Error(`dry-run arm ${options.arm} does not match manifest arm ${options.manifest.arm}`)
  const workspace = path.join(options.root, `${options.workflow.id}-${options.arm}`)
  await materializeWorkflowWorkspace(options.workflow, options.data, workspace)
  const memoryDirectory = path.join(options.root, `${options.workflow.id}-${options.arm}-memory`)
  if (options.arm.endsWith('memory-on')) await copyMemorySnapshot(options.memorySnapshotDirectory, options.manifest.memoryProjectId, memoryDirectory)
  let providerCalls = 0
  const harness = await assembleEpisodeHarness({
    workflow: options.workflow, arm: options.arm, workspace, memoryDirectory, teamsDirectory: path.join(options.root, `${options.workflow.id}-${options.arm}-teams`),
    manifest: options.manifest, adapter: { provider: 'validation', model: 'no-network', chat: async () => { providerCalls += 1; throw new Error('validate-only cannot call a model') } },
  })
  try {
    const tools = harness.capabilityManifest.tools
    if (tools.includes('memory_search') !== options.arm.endsWith('memory-on') || tools.includes('delegate_tasks') !== options.arm.startsWith('team-') || tools.includes('memory_propose')) throw new Error(`dry-run capability mismatch: ${options.workflow.id}/${options.arm}`)
    const untouched = await verifyMemoryTeamWorkflow(options.workflow, workspace)
    if (providerCalls) throw new Error('dry-run dispatched a provider request')
    return { workflowId: options.workflow.id, arm: options.arm, workspace, ...(options.arm.endsWith('memory-on') ? { memoryProjectId: options.manifest.memoryProjectId } : {}), tools, verifierRejectsUntouched: !untouched.passed }
  } finally { await harness.dispose() }
}

