import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { memoryHash } from '../src/core/memory-contracts.js'
import { CLI_BUDGET } from '../src/core/budget.js'
import type { BudgetPolicy } from '../src/core/budget.js'
import { groupPolicy } from '../src/core/task-group-budget.js'
import type { TaskGroupPolicy } from '../src/core/task-group-budget.js'
import { delegationLimits } from '../src/core/delegation-contracts.js'
import type { DelegationLimits } from '../src/core/delegation-contracts.js'
import type { WorkflowDefinition } from './memory-team-verifier.js'

const repository = fileURLToPath(new URL('../../', import.meta.url))
export const MEMORY_TEAM_ARMS = ['single-memory-off', 'single-memory-on', 'team-memory-off', 'team-memory-on'] as const
export type MemoryTeamArm = typeof MEMORY_TEAM_ARMS[number]
export type MemoryTeamPhase = 'development'
export const MEMORY_TEAM_PROTOCOL = 'memory-team-development-v2' as const

// Frozen model contract. `deepseek-v4-flash` is a legacy request name that the
// provider routes to DeepSeek-V4.1-Flash; the probe below verifies the echo.
export const MEMORY_TEAM_MODEL = Object.freeze({
  requested: 'deepseek/deepseek-v4-flash', providerModel: 'deepseek-v4-flash', echoed: 'deepseek-flash',
  version: 'DeepSeek-V4.1-Flash-1017', baseUrl: 'https://api.deepseek.com',
  thinking: 'enabled' as const, sampling: 'provider-default' as const, window: 1_000_000,
})
// Peak USD prices from the official pricing page. Off-peak is half price, so using
// peak rates for the ceiling cannot under-estimate a provider bill.
export const MEMORY_TEAM_PRICE = Object.freeze({
  source: 'https://api-docs.deepseek.com/quick_start/pricing/', capturedAt: '2026-10-27T00:00:00.000Z', currency: 'USD', tier: 'peak',
  inputPerMillion: 0.30, outputPerMillion: 1.20, cacheReadPerMillion: 0.006,
})
// One common budget for prepare + goal + every child + summary + retry. The
// executor's adapter guard enforces it across both runs; the task-group policy
// protects the root share inside each run.
export const MEMORY_TEAM_BUDGET = Object.freeze({
  taskGroup: Object.freeze(groupPolicy({ maxModelRequests: 24, maxToolCalls: 48, maxTotalTokens: 240_000, rootTokenFloor: 80_000, rootRequestFloor: 8, maxWallDurationMs: 900_000 })),
  run: Object.freeze({ ...CLI_BUDGET, maxModelRequests: 24, maxToolCalls: 48, maxTotalTokens: 240_000, contextWindowTokens: 1_000_000, postCompactionPrune: false }),
})
export const MEMORY_TEAM_DELEGATION = Object.freeze(delegationLimits({ maxConcurrent: 2, maxChildrenPerTask: 4, childMaxModelRequests: 8, childMaxToolCalls: 16, childMaxTotalTokens: 80_000 }))
export const MEMORY_TEAM_AMOUNT = Object.freeze({
  perEpisodeUsd: 0.50, batchUsd: 8.50, probeReserveUsd: 0.05,
  note: 'Per-episode cap covers the full 240k-token ceiling at peak output rates; batch cap is 16 x $0.50 plus a $0.05 protocol probe.',
})
const MEMORY_SNAPSHOT_PROJECT_ID = memoryHash('memory-team-development-v2-memory')

export interface ExperienceRecord { workflowId: string; key: string; kind: 'project_fact' | 'procedure' | 'episode'; sourcePath: string; content: string }
export interface MemorySnapshotRecord {
  workflowId: string; kind: ExperienceRecord['kind']; key: string; title: string; content: string; tags: string[]
  anchors: { path: string; contentSha256: string }[]
  sources: { sessionId: string; taskId: string; eventId: string; seq: number; artifactSha256: string }[]
}
export interface MemorySnapshot { projectId: string; records: MemorySnapshotRecord[]; digest: string }
export function memorySourceArtifact(record: MemorySnapshotRecord) {
  const source = record.sources[0]
  if (!source) throw new Error('memory snapshot record has no source')
  const { sessionId, taskId, eventId, seq } = source
  const event = { version: 1, sessionId, taskId, id: eventId, seq, type: 'assistant/message', data: { content: record.content }, at: MEMORY_TEAM_PRICE.capturedAt }
  const artifact = { version: 1, sessionId, taskId, eventId, seq, event }
  return { bytes: Buffer.from(JSON.stringify(artifact)), sha256: memoryHash(JSON.stringify(artifact)) }
}
export interface MemoryTeamData {
  workflows: WorkflowDefinition[]
  experience: ExperienceRecord[]
  experienceDigest: string
  workflowDigest: string
  workflowIds: string[]
  memorySnapshot: MemorySnapshot
}
export interface MemoryTeamEpisode { id: string; workflowId: string; arm: MemoryTeamArm; block: number }
export type PriceSnapshot = typeof MEMORY_TEAM_PRICE
export type MemoryTeamManifest = {
  version: 2; protocol: typeof MEMORY_TEAM_PROTOCOL; phase: MemoryTeamPhase; arm: MemoryTeamArm
  source: { commit: string; codeDigest: string }
  model: typeof MEMORY_TEAM_MODEL; price: PriceSnapshot
  taskGroupPolicy: TaskGroupPolicy; runBudget: BudgetPolicy; delegationLimits: DelegationLimits
  amount: typeof MEMORY_TEAM_AMOUNT
  memory: boolean; team: boolean; postCompactionPrune: false
  experienceDigest: string; workflowDigest: string; workflowIds: string[]; memorySnapshotDigest: string; memoryProjectId: string
  preparationAccessibleToAll: true; paidExecutionAuthorized: false
  episodes: MemoryTeamEpisode[]; plannedEpisodes: 16; digest: string
}

function assertRecord(value: unknown): asserts value is Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid development workflow object') }
export async function loadMemoryTeamData(): Promise<MemoryTeamData> {
  const directory = path.join(repository, 'docs', 'memory-team', 'eval')
  const experience = await fs.readFile(path.join(directory, 'experience.json')), workflows = await fs.readFile(path.join(directory, 'workflows.json'))
  const pack: unknown = JSON.parse(workflows.toString('utf8')), facts: unknown = JSON.parse(experience.toString('utf8'))
  if (!pack || typeof pack !== 'object' || Array.isArray(pack)) throw new Error('invalid development workflow pack')
  const packRecord = pack as Record<string, unknown>
  if (packRecord.version !== 1 || packRecord.phase !== 'development' || !Array.isArray(packRecord.workflows) || packRecord.workflows.length !== 4) throw new Error('invalid development workflow pack')
  if (!facts || typeof facts !== 'object' || Array.isArray(facts)) throw new Error('invalid development preparation data')
  const factRecord = facts as Record<string, unknown>
  if (factRecord.version !== 1 || !Array.isArray(factRecord.records) || factRecord.records.length !== 4) throw new Error('invalid development preparation data')
  const definitions = packRecord.workflows.map(item => {
    assertRecord(item)
    if (typeof item.id !== 'string' || typeof item.category !== 'string' || typeof item.target !== 'string' || !item.acceptance || typeof item.acceptance !== 'object') throw new Error('invalid development workflow')
    if (!item.initialFiles || typeof item.initialFiles !== 'object' || Array.isArray(item.initialFiles) || !item.targetFiles || typeof item.targetFiles !== 'object' || Array.isArray(item.targetFiles)) throw new Error('invalid development workflow files')
    if (!Object.values(item.initialFiles).every(value => typeof value === 'string') || !Object.values(item.targetFiles).every(value => typeof value === 'string')) throw new Error('invalid development workflow file content')
    if (!item.deliverable || typeof item.deliverable !== 'object' || Array.isArray(item.deliverable) || (item.deliverable as Record<string, unknown>).path !== 'answer.json') throw new Error('development workflow must deliver answer.json')
    const acceptance = item.acceptance as Record<string, unknown>
    if (acceptance.kind !== 'memory-team-objective-v1' || !Array.isArray(acceptance.checks)) throw new Error('development workflow lacks objective acceptance')
    return item as unknown as WorkflowDefinition
  })
  const ids = definitions.map(workflow => workflow.id)
  if (new Set(ids).size !== 4) throw new Error('development workflow ids must be unique')
  const records: ExperienceRecord[] = factRecord.records.map(item => {
    assertRecord(item)
    if (typeof item.workflowId !== 'string' || typeof item.key !== 'string' || typeof item.content !== 'string' || typeof item.sourcePath !== 'string' ||
      !['project_fact', 'procedure', 'episode'].includes(String(item.kind))) throw new Error('invalid development preparation record')
    return item as unknown as ExperienceRecord
  })
  const memoryRecords: MemorySnapshotRecord[] = []
  for (const workflow of definitions) {
    const fact = records.find(record => record.workflowId === workflow.id)
    if (!fact) throw new Error(`preparation data is missing ${workflow.id}`)
    const source = workflow.initialFiles[fact.sourcePath]
    if (typeof source !== 'string') throw new Error(`experience has no common source: ${workflow.id}`)
    const sessionId = `prep-session-${workflow.id}`, taskId = `prep-task-${workflow.id}`, eventId = `prep-event-${workflow.id}`, seq = 1
    const record: MemorySnapshotRecord = {
      workflowId: workflow.id, kind: fact.kind, key: fact.key, title: fact.key.replace(/-/g, ' '), content: fact.content,
      tags: [workflow.id.toLowerCase(), workflow.category], anchors: [{ path: fact.sourcePath, contentSha256: memoryHash(source) }],
      sources: [{ sessionId, taskId, eventId, seq, artifactSha256: '' }],
    }
    const artifact = memorySourceArtifact(record)
    record.sources[0]!.artifactSha256 = artifact.sha256
    memoryRecords.push(record)
  }
  const snapshotBody = { projectId: MEMORY_SNAPSHOT_PROJECT_ID, records: memoryRecords }
  const memorySnapshot = { ...snapshotBody, digest: memoryHash(JSON.stringify(snapshotBody)) }
  return {
    workflows: definitions, experience: records, experienceDigest: memoryHash(experience), workflowDigest: memoryHash(workflows),
    workflowIds: ids, memorySnapshot,
  }
}

export function memorySnapshotDigest(snapshot: MemorySnapshot) {
  const { digest: _digest, ...body } = snapshot
  return memoryHash(JSON.stringify(body))
}

export function buildMemoryTeamSchedule(workflowIds: string[]): MemoryTeamEpisode[] {
  if (workflowIds.length !== 4) throw new Error('development schedule requires four workflows')
  const episodes: MemoryTeamEpisode[] = []
  for (const [index, workflowId] of workflowIds.entries()) {
    for (let position = 0; position < MEMORY_TEAM_ARMS.length; position += 1) {
      const arm = MEMORY_TEAM_ARMS[(index + position) % MEMORY_TEAM_ARMS.length]!
      episodes.push({ id: `${workflowId}-${arm}`, workflowId, arm, block: index * MEMORY_TEAM_ARMS.length + position })
    }
  }
  return episodes
}

export function validateMemoryTeamSchedule(episodes: MemoryTeamEpisode[], workflowIds: string[]) {
  if (episodes.length !== 16 || new Set(episodes.map(episode => episode.id)).size !== 16) throw new Error('development schedule must contain 16 independent episodes')
  for (const workflowId of workflowIds) for (const arm of MEMORY_TEAM_ARMS) {
    if (!episodes.some(episode => episode.workflowId === workflowId && episode.arm === arm)) throw new Error(`development schedule is missing ${workflowId}/${arm}`)
  }
  const expected = buildMemoryTeamSchedule(workflowIds)
  if (JSON.stringify(episodes.map(episode => [episode.id, episode.block])) !== JSON.stringify(expected.map(episode => [episode.id, episode.block]))) throw new Error('development schedule order is not the frozen order')
}

export function assertFrozenConfiguration(manifest: MemoryTeamManifest) {
  if (JSON.stringify(manifest.model) !== JSON.stringify(MEMORY_TEAM_MODEL)) throw new Error('development model contract mismatch')
  if (JSON.stringify(manifest.price) !== JSON.stringify(MEMORY_TEAM_PRICE)) throw new Error('development price snapshot mismatch')
  if (JSON.stringify(manifest.taskGroupPolicy) !== JSON.stringify(MEMORY_TEAM_BUDGET.taskGroup)) throw new Error('development task-group budget mismatch')
  if (JSON.stringify(manifest.runBudget) !== JSON.stringify(MEMORY_TEAM_BUDGET.run)) throw new Error('development run budget mismatch')
  if (JSON.stringify(manifest.delegationLimits) !== JSON.stringify(MEMORY_TEAM_DELEGATION)) throw new Error('development delegation limits mismatch')
  if (JSON.stringify(manifest.amount) !== JSON.stringify(MEMORY_TEAM_AMOUNT)) throw new Error('development amount cap mismatch')
  if (manifest.paidExecutionAuthorized !== false) throw new Error('freeze alone is not paid-run authorization')
  if (manifest.postCompactionPrune !== false || manifest.runBudget.postCompactionPrune !== false) throw new Error('development background must explicitly disable postCompactionPrune')
  if (manifest.preparationAccessibleToAll !== true) throw new Error('preparation data must be accessible to all arms')
}
