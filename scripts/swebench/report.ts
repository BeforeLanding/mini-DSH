import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { pairedFourCell, summarizeEpisodes, tokenCapFromUsd, validateRunManifest } from './protocol.js'
import type { EpisodeRecord, SwebenchRunManifest } from './protocol.js'
import { COMPONENT_PROTOCOL, COMPONENT_PAIRS } from './component-protocol.js'
import { componentExposure, readComponentMetrics } from './component-metrics.js'
import type { ComponentMetrics } from './component-metrics.js'

// 报告只从已落盘的 episode 记录与独立判分结果重算；判分不在这里发生，避免“报告时顺手改判”。
export interface SwebenchEpisodeResult extends EpisodeRecord {
  armId: string
  emptyPatch: boolean
  sessionId?: string
  eventsPath?: string
  patchPath: string
  external?: Record<string, unknown>
  error?: string
  components?: ComponentMetrics
}

export interface SwebenchScoreResult {
  armId: string
  instanceId: string
  resolved: boolean
  classification: 'resolved' | 'unresolved' | 'error' | 'empty'
  scoreRunId: string
  rawPath?: string
}

export interface SwebenchScores {
  runIds: Record<string, string>
  results: SwebenchScoreResult[]
}

const declaredPairs = [['candidate', 'baseline'], ['context-reference', 'context-proposed']] as const

export function buildReport(manifest: SwebenchRunManifest, split: 'development' | 'formal', records: readonly SwebenchEpisodeResult[],
  scores: SwebenchScores, batch: { stopReason?: string; spentUsdEstimate?: number; unknownCostEpisodes?: number; startedAt: string; finishedAt: string }) {
  const batchManifest = manifest[split]
  const armIds = batchManifest.arms
  const plannedByArm = new Map<string, string[]>(armIds.map(armId => [armId, []]))
  for (const episode of batchManifest.schedule) plannedByArm.get(episode.armId)?.push(episode.instanceId)
  const plannedKeys = new Set(batchManifest.schedule.map(episode => `${episode.armId}/${episode.instanceId}`))
  const recordKeys = records.map(record => `${record.armId}/${record.instanceId}`)
  if (new Set(recordKeys).size !== records.length || recordKeys.some(key => !plannedKeys.has(key))) throw new Error('duplicate or unplanned episode record')
  const scoreByArm = new Map<string, Map<string, SwebenchScoreResult>>()
  for (const result of scores.results) {
    const arm = scoreByArm.get(result.armId) ?? new Map<string, SwebenchScoreResult>()
    if (!plannedKeys.has(`${result.armId}/${result.instanceId}`) || arm.has(result.instanceId)) throw new Error('duplicate or unplanned score')
    if (!recordKeys.includes(`${result.armId}/${result.instanceId}`) || result.resolved !== (result.classification === 'resolved')) throw new Error('score has no episode or inconsistent resolved flag')
    arm.set(result.instanceId, result)
    scoreByArm.set(result.armId, arm)
  }
  const perArm = armIds.map(armId => {
    const planned = plannedByArm.get(armId) ?? []
    const executed = records.filter(record => record.armId === armId)
    const scored = scoreByArm.get(armId) ?? new Map<string, SwebenchScoreResult>()
    const withScores = executed.map(record => ({ ...record, resolved: scored.get(record.instanceId)?.resolved ?? false }))
    const summary = summarizeEpisodes(withScores)
    const plannedResolved = planned.filter(instanceId => scored.get(instanceId)?.resolved === true).length
    const definition = manifest.arms.find(arm => arm.id === armId)
    const readings = planned.map(instanceId => executed.find(record => record.instanceId === instanceId)?.components)
    const tokenCap = manifest.prices ? tokenCapFromUsd(manifest.caps[split === 'development' ? 'developmentPerTask' : 'perTask'].maxCostUsd, manifest.prices) : undefined
    const overCap = executed.filter(record => tokenCap !== undefined && record.inputTokens !== undefined && record.outputTokens !== undefined && record.inputTokens + record.outputTokens > tokenCap)
    return {
      armId,
      system: definition?.system ?? 'mini-dsh',
      ...(definition?.system === 'external' && definition.external ? { external: definition.external } : {}),
      planned: planned.length,
      executed: executed.length,
      unexecuted: planned.length - executed.length,
      scored: scored.size,
      resolvedOverPlanned: plannedResolved,
      resolvedRateOverPlanned: planned.length ? plannedResolved / planned.length : 0,
      ...summary,
      ...(executed.some(record => record.components) ? { components: {
        context: componentExposure(readings, 'context'), toolOutput: componentExposure(readings, 'toolOutput'), projectContext: componentExposure(readings, 'projectContext'),
        summaryAttempts: executed.reduce((sum, record) => sum + (record.components?.context.attempts ?? 0), 0),
        summaryApplied: executed.reduce((sum, record) => sum + (record.components?.context.applied ?? 0), 0),
        previewTruncations: executed.reduce((sum, record) => sum + (record.components?.toolOutput.previewTruncations ?? 0), 0),
        successfulRecalls: executed.reduce((sum, record) => sum + (record.components?.toolOutput.successfulRecalls ?? 0), 0),
        checks: executed.reduce((sum, record) => sum + (record.components?.verification.finished ?? 0), 0),
        reportReads: executed.reduce((sum, record) => sum + (record.components?.verification.reportReads ?? 0), 0),
      } } : {}),
      ...(tokenCap === undefined ? {} : { tokenBudget: { nominalCap: tokenCap, overCapEpisodes: overCap.length,
        unknownEpisodes: planned.filter(instanceId => { const record = executed.find(record => record.instanceId === instanceId); return !record || record.usageUnknown || record.inputTokens === undefined || record.outputTokens === undefined }).length,
        resolvedWithinCapOverPlanned: planned.filter(instanceId => { const record = executed.find(record => record.instanceId === instanceId); return record && !record.usageUnknown && record.inputTokens !== undefined && record.outputTokens !== undefined && record.inputTokens + record.outputTokens <= tokenCap && scored.get(instanceId)?.resolved }).length } }),
      note: 'resolved@1 denominator is all planned episodes; executed-only counts are listed separately',
    }
  })
  const armByName = new Map(perArm.map(arm => [arm.armId, arm]))
  const pairs = (manifest.selection as { protocol?: unknown })?.protocol === COMPONENT_PROTOCOL ? COMPONENT_PAIRS : declaredPairs
  const paired = pairs.flatMap(([left, right]) => {
    const a = scoreByArm.get(left), b = scoreByArm.get(right)
    if (!armByName.has(left) || !armByName.has(right)) return []
    const aResolved = new Map((plannedByArm.get(left) ?? []).map(instanceId => [instanceId, a?.get(instanceId)?.resolved ?? false]))
    const bResolved = new Map((plannedByArm.get(right) ?? []).map(instanceId => [instanceId, b?.get(instanceId)?.resolved ?? false]))
    const complete = !batch.stopReason && [...aResolved.keys()].every(id => a?.has(id) && b?.has(id) && a.get(id)?.classification !== 'error' && b.get(id)?.classification !== 'error')
    return [{ arms: [left, right] as [string, string], complete, ...pairedFourCell(aResolved, bResolved) }]
  })
  const classified = (classification: SwebenchScoreResult['classification']) => scores.results.filter(result => result.classification === classification && plannedByArm.get(result.armId)?.includes(result.instanceId))
  const failureTraces = [
    (() => {
      const first = records.find(record => record.status === 'infrastructure')
      return first ? { kind: 'provider-or-infrastructure', armId: first.armId, instanceId: first.instanceId, events: first.eventsPath,
        patch: first.patchPath, ...(first.external ? { external: first.external } : {}), error: first.error } : { kind: 'provider-or-infrastructure', absent: true }
    })(),
    (() => {
      const first = records.find(record => record.status === 'budget' || record.status === 'timeout')
      return first ? { kind: 'budget-stop', armId: first.armId, instanceId: first.instanceId, events: first.eventsPath,
        patch: first.patchPath, ...(first.external ? { external: first.external } : {}) } : { kind: 'budget-stop', absent: true }
    })(),
    (() => {
      const first = records.find(record => record.status === 'completed' && !record.emptyPatch && scoreByArm.get(record.armId)?.get(record.instanceId)?.resolved !== true)
      return first ? { kind: 'logically-wrong-non-empty-patch', armId: first.armId, instanceId: first.instanceId, events: first.eventsPath, patch: first.patchPath } : { kind: 'logically-wrong-non-empty-patch', absent: true }
    })(),
  ]
  const unknownCostEpisodes = records.filter(record => record.usageUnknown || record.costUsd === undefined).length
  return {
    schemaVersion: 1,
    kind: 'swebench-batch-report',
    dataset: manifest.dataset,
    harnessCommit: manifest.harnessCommit,
    split,
    freezeStatus: manifest.freezeStatus,
    batch: { ...batch, unknownCostEpisodes, note: 'estimate from provider usage and the frozen price snapshot; not a provider invoice' },
    plannedEpisodes: batchManifest.schedule.length,
    executedEpisodes: records.length,
    unexecutedEpisodes: batchManifest.schedule.length - records.length,
    perArm,
    scoring: {
      resolved: classified('resolved').length,
      unresolved: classified('unresolved').length,
      empty: classified('empty').length,
      error: classified('error').length,
      errorNote: 'scoring errors stay in the planned denominator and are reported separately',
      runIds: scores.runIds,
    },
    paired,
    ...((manifest.selection as { protocol?: unknown })?.protocol !== COMPONENT_PROTOCOL ? {} : {
      componentComparisons: ([['without-context', 'context'], ['without-tool-output', 'toolOutput'], ['without-project-context', 'projectContext']] as const).map(([armId, component]) => {
        const pair = paired.find(pair => pair.arms[1] === armId)
        const exposure = armByName.get('full')?.components?.[component]
        return { component, arms: ['full', armId], exposure,
          interpretation: !pair?.complete || !exposure || exposure.coverage === 'unknown' ? 'incomplete-evidence'
            : exposure.coverage === 'not-exercised' ? 'not-exercised' : 'descriptive-only',
          resolvedDifference: pair?.rateDifference,
          note: 'Exposure is not benefit. Small development samples cannot establish a causal or general success-rate gain.' }
      }),
    }),
    failureTraces,
    evidence: records.map(record => ({ armId: record.armId, instanceId: record.instanceId, status: record.status,
      events: record.eventsPath, patch: record.patchPath, sessionId: record.sessionId, costUsd: record.costUsd, usageUnknown: record.usageUnknown,
      ...(record.external ? { external: record.external } : {}) })),
    caveat: armIds.some(armId => manifest.arms.find(arm => arm.id === armId)?.system === 'external')
      ? 'The external arm is the unmodified mini-SWE-agent (native prompt, single bash tool, linear context). This is a system-level comparison, not an isolated prompt or context factor; synthetic or mock runs are mechanism evidence only.'
      : 'Synthetic or mock runs in this file are mechanism evidence only, not a model capability score.',
  }
}

export async function writeReport(evidenceRoot: string, report: ReturnType<typeof buildReport>) {
  const target = path.join(evidenceRoot, 'report.json')
  // report 是派生文件：批次恢复时按 runs.jsonl 与 scores.json 重算并覆盖，原始记录仍只追加/重写一次。
  await fs.writeFile(target, JSON.stringify(report, null, 2) + '\n')
  return target
}

function argument(name: string) {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  if (!value || value.startsWith('--')) throw new Error(`missing ${name}`)
  return value
}

async function cli() {
  const root = path.resolve(argument('--evidence-root'))
  const manifest = validateRunManifest(JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8')))
  const runs = (await fs.readFile(path.join(root, 'runs.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as SwebenchEpisodeResult)
  const scores = JSON.parse(await fs.readFile(path.join(root, 'scores.json'), 'utf8')) as SwebenchScores
  for (const record of runs) if (record.eventsPath && record.sessionId) record.components = await readComponentMetrics(root, record)
  const batch = JSON.parse(await fs.readFile(path.join(root, 'batch.json'), 'utf8')) as { split: 'development' | 'formal'; stopReason?: string; spentUsdEstimate?: number; startedAt: string; finishedAt: string }
  const report = buildReport(manifest, batch.split, runs, scores, batch)
  const target = path.join(root, 'report.json')
  await fs.writeFile(target, JSON.stringify(report, null, 2) + '\n')
  console.log(`wrote ${target}: executed ${report.executedEpisodes}/${report.plannedEpisodes}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void cli().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
