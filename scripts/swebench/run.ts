import { spawnSync } from 'node:child_process'
import type { SpawnSyncReturns } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { pathToFileURL } from 'node:url'
import { createHarness } from '../../src/app/create-harness.js'
import type { HarnessAdapter } from '../../src/app/create-harness.js'
import { BudgetStop } from '../../src/core/budget.js'
import type { BudgetPolicy } from '../../src/core/budget.js'
import { JsonlStore } from '../../src/core/event-store.js'
import { createDeepSeekAdapter } from '../../src/models/deepseek.js'
import { createDockerCandidateRunner } from './docker-candidate.js'
import {
  assertSanitizedInstances, classifyRunStatus, tokenCapFromUsd, usageCost, validatePrediction, validateRunManifest,
} from './protocol.js'
import type { EpisodeStatus, SwebenchArm, SwebenchInstance, SwebenchPrediction, SwebenchRunManifest } from './protocol.js'
import { buildReport, writeReport } from './report.js'
import type { SwebenchEpisodeResult, SwebenchScoreResult, SwebenchScores } from './report.js'
import { exportDockerWorkspace, exportPatch, prepareDockerWorkspace, prepareFixtureWorkspace, removeContainerIfPresent } from './workspace.js'
import { preflightExternal, runExternalEpisode } from './external-run.js'
import type { ExternalEpisodeOutcome, ExternalEpisodeRequest } from './external-run.js'
import { CANDIDATE_PATH_GUIDANCE, probeCommandEnvironment, validateCommandEnvironment } from './command-environment.js'
import { assertComponentSource } from './component-protocol.js'
import { componentMetrics, readComponentMetrics } from './component-metrics.js'
import type { ComponentMetrics } from './component-metrics.js'

// R10 执行器：复用 createHarness、官方预测格式与独立判分通道。它不替用户决定模型、价格或授权；
// 冻结文件里缺任何一项就拒绝执行。正式批次与开发批次共用同一实现，但题号、顺序与上限分别冻结。
export interface RunBatchOptions {
  manifest: SwebenchRunManifest
  manifestPath: string
  datasetPath: string
  evidenceRoot: string
  split: 'development' | 'formal'
  backend: 'fixture' | 'docker'
  scoring: 'mock' | 'official'
  // Full official rows (including test_patch and FAIL_TO_PASS/PASS_TO_PASS).
  // Used only by the official scorer; never copied into evidence or shown to the Agent.
  scoringDataset?: string
  batchId: string
  fixtureRoot?: string
  adapterFor?: (arm: SwebenchArm, instance: SwebenchInstance) => HarnessAdapter | Promise<HarnessAdapter>
  externalRunner?: (request: ExternalEpisodeRequest) => Promise<ExternalEpisodeOutcome>
  externalPython?: string
  scoreMock?: (instance: SwebenchInstance, workspace: string) => boolean | Promise<boolean>
  now?: () => number
  // 批次级恢复：跳过已经落盘终态的 episode，继续剩余计划；中断的 episode 保留为 infrastructure，
  // 不自动重跑（重跑会变成同一题 arm 的第二次正式 attempt）。
  resume?: boolean
  validateOnly?: boolean
}

function sanitizeName(value: string) { return value.replace(/[^A-Za-z0-9_.-]/g, '-') }

function relativeExternalEvidence(evidence: Record<string, unknown>, root: string): Record<string, unknown> {
  const result = { ...evidence }
  for (const key of ['datasetPath', 'configPath', 'stdoutPath', 'stderrPath', 'trajectoryPath', 'predictionPath', 'logPath', 'resultPath']) {
    const value = result[key]
    if (typeof value === 'string') result[key] = path.relative(root, value)
  }
  return result
}

function adapterFromArm(arm: SwebenchArm): HarnessAdapter {
  if (!arm.model.name) throw new Error(`arm ${arm.id}: model name is required for execution`)
  const adapter = createDeepSeekAdapter({ models: [arm.model.name] })
  return { provider: arm.model.provider, model: arm.model.name, chat: adapter.chat.bind(adapter),
    capabilities: { [arm.model.name]: { contextWindowTokens: arm.model.contextWindowTokens } } }
}

async function trace(prediction: SwebenchPrediction, fixture: string, target: string, score: (instance: SwebenchInstance, workspace: string) => boolean | Promise<boolean>, instance: SwebenchInstance) {
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.cp(fixture, target, { recursive: true, errorOnExist: true })
  if (!prediction.model_patch.trim()) return { resolved: false, classification: 'empty' as const }
  const applied = spawnSync('git', ['apply', '--whitespace=nowarn', '-'], { cwd: target, input: prediction.model_patch, encoding: 'utf8', timeout: 60_000 })
  if (applied.status !== 0) throw new Error(`mock scorer could not apply patch for ${instance.instance_id}: ${applied.stderr.slice(0, 1000)}`)
  return { resolved: Boolean(await score(instance, target)), classification: 'scored' as const }
}

// The official harness needs `test_patch` and the test directives. The Agent
// dataset is sanitized and intentionally lacks them. Load them from a separate
// hidden file, validate the identity fields against the frozen batch, and keep
// the full rows out of the evidence directory.
async function loadScoringRows(file: string, entries: readonly SwebenchInstance[]) {
  const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as unknown
  if (!Array.isArray(parsed)) throw new Error('scoring dataset must be a JSON array of full SWE-bench rows')
  const byId = new Map<string, Record<string, unknown>>()
  for (const value of parsed) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const row = value as Record<string, unknown>
    if (typeof row.instance_id === 'string') byId.set(row.instance_id, row)
  }
  const rows = new Map<string, Record<string, unknown>>()
  for (const entry of entries) {
    const row = byId.get(entry.instance_id)
    if (!row) throw new Error(`scoring dataset is missing ${entry.instance_id}`)
    if (row.repo !== entry.repo || row.base_commit !== entry.base_commit) {
      throw new Error(`scoring dataset row ${entry.instance_id} does not match the frozen repo/base_commit`)
    }
    if (typeof row.test_patch !== 'string') throw new Error(`scoring dataset row ${entry.instance_id} lacks test_patch`)
    if (row.FAIL_TO_PASS === undefined || row.PASS_TO_PASS === undefined) {
      throw new Error(`scoring dataset row ${entry.instance_id} lacks FAIL_TO_PASS/PASS_TO_PASS`)
    }
    rows.set(entry.instance_id, row)
  }
  return rows
}

async function officialScores(options: RunBatchOptions, arm: SwebenchArm, predictions: SwebenchPrediction[], entries: readonly SwebenchInstance[],
  runId: string, scoringRows: ReadonlyMap<string, Record<string, unknown>>) {
  const predictionsPath = path.join(options.evidenceRoot, `predictions.${sanitizeName(arm.id)}.jsonl`)
  await fs.writeFile(predictionsPath, predictions.map(value => JSON.stringify(validatePrediction(value)) + '\n').join(''))
  const rows = entries.map(entry => scoringRows.get(entry.instance_id)!)
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-scoring-'))
  const datasetFile = path.join(temporaryDirectory, 'dataset.json')
  await fs.writeFile(datasetFile, JSON.stringify(rows, null, 2) + '\n', { mode: 0o600 })
  const modelName = `mini-dsh-${sanitizeName(arm.id)}`
  const logPath = path.join(options.evidenceRoot, `score.${sanitizeName(arm.id)}.log`)
  let result: SpawnSyncReturns<string> | undefined
  try {
    result = spawnSync('python', ['-m', 'swebench.harness.run_evaluation', '--dataset_name', datasetFile,
      '--predictions_path', predictionsPath, '--max_workers', '1', '--timeout', '1800', '--cache_level', 'instance',
      '--clean', 'false', '--namespace', 'swebench', '--run_id', runId], { cwd: options.evidenceRoot, encoding: 'utf8', timeout: 24 * 60 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 })
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true })
  }
  if (!result) throw new Error(`official scoring did not run for ${arm.id}`)
  await fs.writeFile(logPath, `${result.stdout ?? ''}\n${result.stderr ?? ''}`)
  if (result.status !== 0) throw new Error(`official scoring failed for ${arm.id}: ${(result.stderr ?? '').slice(-2000)}`)
  const reportPath = path.join(options.evidenceRoot, `${modelName}.${runId}.json`)
  const report = JSON.parse(await fs.readFile(reportPath, 'utf8')) as Record<string, unknown>
  const list = (key: string) => new Set(Array.isArray(report[key]) ? report[key] as string[] : [])
  const resolved = list('resolved_ids'), unresolved = list('unresolved_ids'), empty = list('empty_patch_ids'), errors = list('error_ids')
  return predictions.map(prediction => {
    const classification: SwebenchScoreResult['classification'] =
      errors.has(prediction.instance_id) ? 'error' : resolved.has(prediction.instance_id) ? 'resolved'
        : empty.has(prediction.instance_id) ? 'empty' : unresolved.has(prediction.instance_id) ? 'unresolved' : 'error'
    return { armId: arm.id, instanceId: prediction.instance_id, resolved: classification === 'resolved', classification,
      scoreRunId: runId, rawPath: path.relative(options.evidenceRoot, reportPath) }
  })
}

export async function runSwebenchBatch(options: RunBatchOptions) {
  const manifest = options.manifest
  if (manifest.executionScope === 'development' && options.split !== 'development') throw new Error('manifest is frozen for development only; formal requires a new freeze')
  const commandEnvironment = validateCommandEnvironment(manifest.environment.commandEnvironment)
  assertComponentSource(manifest)
  if (manifest.freezeStatus !== 'frozen') throw new Error('refusing to execute a draft manifest; finalize the protocol first')
  if (manifest.paidRequests !== 0) throw new Error('manifest must start with paidRequests: 0')
  if (options.scoring === 'official' && !manifest.prices) throw new Error('official scoring requires a frozen price snapshot for cost accounting')
  if (options.scoring === 'mock' && !options.scoreMock && !options.fixtureRoot) throw new Error('mock scoring requires a score function or a fixture root')
  if (options.scoring === 'official' && !options.scoringDataset) {
    throw new Error('official scoring requires --scoring-dataset with the full SWE-bench rows (test_patch); the Agent dataset is sanitized')
  }
  const rawRows = JSON.parse(await fs.readFile(options.datasetPath, 'utf8')) as unknown
  if (!Array.isArray(rawRows)) throw new Error('dataset must be a JSON array')
  assertSanitizedInstances(rawRows)
  const dataset = new Map((rawRows as SwebenchInstance[]).map(instance => [instance.instance_id, instance]))
  const batchManifest = manifest[options.split]
  const arms = new Map(manifest.arms.map(arm => [arm.id, arm]))
  const instances = new Map(batchManifest.instances.map(instance => [instance.instance_id, instance]))
  for (const entry of batchManifest.schedule) if (!dataset.has(entry.instanceId)) throw new Error(`dataset is missing scheduled instance ${entry.instanceId}`)
  if (options.backend === 'docker') {
    const digests = manifest.environment.imageDigests
    if (!digests) throw new Error('docker backend requires frozen per-instance image digests')
    for (const entry of batchManifest.schedule) if (!digests[entry.instanceId]) throw new Error(`missing image digest for ${entry.instanceId}`)
  }
  if (options.backend === 'fixture' && !options.fixtureRoot) throw new Error('fixture backend requires --fixtures <directory>')
  const splitArmIds = new Set(batchManifest.arms)
  const externalArms = manifest.arms.filter(arm => splitArmIds.has(arm.id) && arm.system === 'external')
  let externalPreflight: Awaited<ReturnType<typeof preflightExternal>> | undefined
  if (externalArms.length) {
    if (options.backend !== 'docker' && !options.externalRunner) throw new Error('external arms require the docker backend')
    if (!manifest.prices) throw new Error('external arms require a frozen price snapshot')
    if (!options.externalRunner) {
      externalPreflight = await preflightExternal({ manifest, split: options.split, instances: batchManifest.instances,
        images: manifest.environment.imageDigests ?? {}, python: options.externalPython ?? process.env.MINI_DSH_EXTERNAL_PYTHON ?? 'python', requireCredential: !options.validateOnly })
    }
  }
  const scoringRows = options.scoring === 'official'
    ? await loadScoringRows(options.scoringDataset!, batchManifest.instances)
    : undefined
  const environmentProbes: ReturnType<typeof probeCommandEnvironment>[] = []
  if (options.backend === 'docker' && commandEnvironment === 'testbed-v1') {
    const uid = process.getuid?.(), gid = process.getgid?.()
    if (uid === undefined || gid === undefined) throw new Error('testbed environment requires a POSIX uid/gid')
    for (const image of new Set(batchManifest.instances.map(instance => manifest.environment.imageDigests![instance.instance_id]!))) {
      environmentProbes.push(probeCommandEnvironment(image, uid, gid))
    }
  }
  const now = options.now ?? (() => Date.now())
  let startedAt = new Date().toISOString()
  if (options.validateOnly) return { ...buildReport(manifest, options.split, [], { runIds: {}, results: [] }, { startedAt, finishedAt: startedAt }),
    validationOnly: true, paidRequests: 0, environmentProbes }
  const records: SwebenchEpisodeResult[] = []
  if (options.resume) {
    const savedManifest = JSON.parse(await fs.readFile(path.join(options.evidenceRoot, 'manifest.json'), 'utf8')) as unknown
    if (!isDeepStrictEqual(savedManifest, manifest)) throw new Error('resume manifest does not match the evidence directory')
    const savedDataset = JSON.parse(await fs.readFile(path.join(options.evidenceRoot, 'dataset.json'), 'utf8')) as unknown
    if (!isDeepStrictEqual(savedDataset, batchManifest.instances)) throw new Error('resume dataset does not match the evidence directory')
    for (const line of (await fs.readFile(path.join(options.evidenceRoot, 'runs.jsonl'), 'utf8')).split('\n').filter(Boolean)) records.push(JSON.parse(line) as SwebenchEpisodeResult)
    const planned = new Set(batchManifest.schedule.map(entry => `${entry.instanceId}/${entry.armId}`))
    if (new Set(records.map(record => `${record.instanceId}/${record.armId}`)).size !== records.length) throw new Error('resume evidence contains duplicate episodes')
    if (records.some(record => !planned.has(`${record.instanceId}/${record.armId}`))) throw new Error('resume evidence contains an episode outside the frozen schedule')
    const previous = JSON.parse(await fs.readFile(path.join(options.evidenceRoot, 'batch.json'), 'utf8').catch(() => '{}')) as { startedAt?: string }
    if (previous.startedAt) startedAt = previous.startedAt
  } else {
    await fs.mkdir(path.dirname(options.evidenceRoot), { recursive: true })
    await fs.mkdir(options.evidenceRoot, { recursive: false })
    await fs.writeFile(path.join(options.evidenceRoot, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
    await fs.writeFile(path.join(options.evidenceRoot, 'dataset.json'), JSON.stringify(batchManifest.instances, null, 2) + '\n')
  }
  if (environmentProbes.length) await fs.writeFile(path.join(options.evidenceRoot, 'environment-preflight.json'), JSON.stringify(environmentProbes, null, 2) + '\n')
  let stopReason: string | undefined
  let spentUsd = records.reduce((sum, record) => sum + (record.costUsd ?? 0), 0)
  let unknownCostEpisodes = records.filter(record => record.usageUnknown).length
  const runHandle = await fs.open(path.join(options.evidenceRoot, 'runs.jsonl'), 'a')
  try {
    for (const [index, entry] of batchManifest.schedule.entries()) {
      if (records.some(record => record.instanceId === entry.instanceId && record.armId === entry.armId)) continue
      if (records.length >= manifest.caps.batch.maxEpisodes) { stopReason = 'batch_episode_cap'; break }
      const perTask = options.split === 'development' ? manifest.caps.developmentPerTask : manifest.caps.perTask
      if (manifest.prices && spentUsd + perTask.maxCostUsd > manifest.caps.batch.maxCostUsd) { stopReason = 'batch_cost_cap_before_next_episode'; break }
      const arm = arms.get(entry.armId)
      const instance = instances.get(entry.instanceId)
      if (!arm || !instance) throw new Error(`schedule references unknown arm/instance: ${entry.armId}/${entry.instanceId}`)
      const episodeDirectory = path.join(options.evidenceRoot, 'episodes', sanitizeName(entry.instanceId), sanitizeName(arm.id))
      await fs.mkdir(episodeDirectory, { recursive: true })
      const patchPath = path.join(episodeDirectory, 'patch.diff')
      let eventsPath: string | undefined, sessionId: string | undefined
      let components: ComponentMetrics | undefined
      let status: EpisodeStatus = 'infrastructure', error: string | undefined
      let costUsd: number | undefined, usageUnknown = true
      let counters = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, modelRequests: 0, toolCalls: 0, activeDurationMs: 0 }
      let patch = ''
      let dockerWorkspace: Awaited<ReturnType<typeof prepareDockerWorkspace>> | undefined
      let externalEvidence: Record<string, unknown> | undefined
      const began = now()
      try {
        const workspace = path.join(episodeDirectory, 'workspace')
        if (options.backend === 'docker') {
          // 中断恢复时只清理本批次命名规则下的残留；不执行中断 episode，保留其 infrastructure 记录。
          removeContainerIfPresent(`mini-dsh-run-${sanitizeName(options.batchId)}-${index}`)
          removeContainerIfPresent(`mini-dsh-export-${sanitizeName(options.batchId)}-${index}`)
        }
        if (arm.system === 'external') {
          let exportEvidence: Record<string, unknown> | undefined
          if (options.backend === 'fixture') {
            await prepareFixtureWorkspace(path.join(options.fixtureRoot!, entry.instanceId), workspace)
          } else {
            const exported = await exportDockerWorkspace({ image: manifest.environment.imageDigests![entry.instanceId]!, baseCommit: instance.base_commit,
              target: workspace, exportName: `mini-dsh-export-${sanitizeName(options.batchId)}-${index}` })
            exportEvidence = exported.evidence
          }
          const request: ExternalEpisodeRequest = {
            arm, instance, image: manifest.environment.imageDigests?.[entry.instanceId] ?? '',
            workspace, episodeDirectory, batchId: options.batchId, index,
            caps: { maxCostUsd: perTask.maxCostUsd, maxModelRequests: perTask.maxModelRequests, maxToolCalls: perTask.maxToolCalls,
              wallClockMs: perTask.wallClockMs, maxOutputTokens: perTask.maxOutputTokens,
              maxTotalTokens: tokenCapFromUsd(perTask.maxCostUsd, manifest.prices!) },
            prices: manifest.prices,
            python: externalPreflight?.python ?? options.externalPython ?? process.env.MINI_DSH_EXTERNAL_PYTHON ?? 'python',
            upstreamConfigPath: externalPreflight?.upstreamConfigPath ?? '',
            upstreamConfigSha256: externalPreflight?.upstreamConfigSha256 ?? '',
            model: externalPreflight?.model ?? `${arm.model.provider}/${arm.model.name ?? ''}`,
            apiKeyEnv: arm.external?.apiKeyEnv ?? 'DEEPSEEK_API_KEY',
            timeoutMs: perTask.wallClockMs + 120_000,
            commandEnvironment,
          }
          const outcome = options.externalRunner ? await options.externalRunner(request) : await runExternalEpisode(request)
          status = outcome.status
          patch = outcome.patch
          costUsd = outcome.costUsd
          usageUnknown = outcome.usageUnknown
          counters = outcome.counters
          if (outcome.status === 'infrastructure' || outcome.status === 'failed') error = outcome.error
          externalEvidence = { ...relativeExternalEvidence(outcome.external as unknown as Record<string, unknown>, options.evidenceRoot),
            ...(exportEvidence ? { workspaceExport: exportEvidence } : {}) }
          await fs.writeFile(patchPath, patch)
        } else {
        let baseCommit: string
        if (options.backend === 'fixture') {
          baseCommit = await prepareFixtureWorkspace(path.join(options.fixtureRoot!, entry.instanceId), workspace)
        } else {
          dockerWorkspace = await prepareDockerWorkspace({ image: manifest.environment.imageDigests![entry.instanceId]!, baseCommit: instance.base_commit,
            target: workspace, exportName: `mini-dsh-export-${sanitizeName(options.batchId)}-${index}`, containerName: `mini-dsh-run-${sanitizeName(options.batchId)}-${index}` })
          baseCommit = dockerWorkspace.patchBase
        }
        const adapter = options.adapterFor ? await options.adapterFor(arm, instance) : adapterFromArm(arm)
        const prices = manifest.prices
        const budget: BudgetPolicy = {
          ...arm.budget as BudgetPolicy,
          maxModelRequests: perTask.maxModelRequests, maxToolCalls: perTask.maxToolCalls,
          maxActiveDurationMs: perTask.wallClockMs, maxOutputTokens: perTask.maxOutputTokens,
          ...(prices ? { maxTotalTokens: tokenCapFromUsd(perTask.maxCostUsd, prices) } : {}),
        }
        const harness = await createHarness({ workspace, profile: 'coding', autoApprove: true, projectContext: false,
          contextLayout: 'frozen', runtimeClockMode: 'frozen', toolOutput: true, ...arm.harness, adapter,
          ...(dockerWorkspace ? { commandRunner: createDockerCandidateRunner(workspace, dockerWorkspace.containerName, { commandEnvironment }) } : {}) })
        try {
          if (dockerWorkspace && commandEnvironment === 'testbed-v1') harness.root.systemPrompt.context({ name: 'swebench:environment', order: 110, text: CANDIDATE_PATH_GUIDANCE })
          const session = harness.root.sessions.create({ source: `swebench-${options.split}`, workspace })
          sessionId = session.id
          const store = await JsonlStore.open(path.join(episodeDirectory, 'session'), session.id)
          harness.root.sessions.attachStore(session.id, store)
          eventsPath = path.relative(options.evidenceRoot, path.join(episodeDirectory, 'session', session.id, 'events.jsonl'))
          const agent = harness.root.agents.create({ name: arm.id, sessionId: session.id, model: `${adapter.provider}/${adapter.model}`, loop: harness.root.agentLoop, budget })
          let thrown: unknown
          try { await agent.send(manifest.promptTemplate.replaceAll('{problem_statement}', instance.problem_statement ?? '')) } catch (cause) { thrown = cause }
          const state = harness.root.sessions.latestRun(session.id)
          const stop = state?.status ?? (thrown instanceof BudgetStop ? thrown.reason : 'error')
          status = classifyRunStatus(String(stop))
          if (thrown !== undefined && !(thrown instanceof BudgetStop)) status = 'infrastructure'
          if (thrown !== undefined) error = thrown instanceof Error ? thrown.message : String(thrown)
          if (state) {
            counters = { inputTokens: state.counters.inputTokens, outputTokens: state.counters.outputTokens, cacheReadTokens: state.counters.cacheReadTokens,
              modelRequests: state.counters.modelRequests, toolCalls: state.counters.toolCalls, activeDurationMs: state.counters.activeDurationMs }
            const usage = prices ? usageCost(state.usage, prices) : { unknown: true, reason: 'no price snapshot' }
            costUsd = usage.costUsd
            usageUnknown = usage.unknown
            if (usage.unknown && usage.reason) error = error ?? `usage unknown: ${usage.reason}`
          }
          patch = exportPatch(workspace, baseCommit)
          await fs.writeFile(patchPath, patch)
          await harness.root.sessions.flush(session.id)
          components = componentMetrics(harness.root.sessions.confirmedEvents(session.id))
        } finally {
          await harness.root.sessions.close().catch(cause => { status = 'infrastructure'; error = error ?? `session store close failed: ${String(cause)}` })
          await harness.dispose()
        }
        }
      } catch (cause) {
        status = 'infrastructure'
        error = cause instanceof Error ? cause.message : String(cause)
        await fs.writeFile(patchPath, patch).catch(() => {})
      } finally {
        dockerWorkspace?.cleanup()
      }
      const record: SwebenchEpisodeResult = { instanceId: entry.instanceId, armId: arm.id, status, resolved: false, emptyPatch: patch.trim().length === 0,
        ...(components ? { components } : {}),
        ...(costUsd === undefined ? {} : { costUsd }), usageUnknown, inputTokens: counters.inputTokens, outputTokens: counters.outputTokens,
        cacheReadTokens: counters.cacheReadTokens, durationMs: Math.max(0, now() - began), modelRequests: counters.modelRequests, toolCalls: counters.toolCalls,
        ...(sessionId ? { sessionId } : {}), ...(eventsPath ? { eventsPath } : {}), patchPath: path.relative(options.evidenceRoot, patchPath),
        ...(externalEvidence ? { external: externalEvidence } : {}), ...(error ? { error } : {}) }
      await fs.writeFile(path.join(episodeDirectory, 'episode.json'), JSON.stringify({ ...record, workspace: path.relative(options.evidenceRoot, path.join(episodeDirectory, 'workspace')),
        ...(dockerWorkspace ? { container: dockerWorkspace.evidence } : {}) }, null, 2) + '\n')
      await runHandle.write(JSON.stringify(record) + '\n')
      records.push(record)
      if (status === 'infrastructure') { stopReason = 'infrastructure_failure'; break }
      if (costUsd !== undefined) spentUsd += costUsd
      if (usageUnknown && manifest.prices) { unknownCostEpisodes++; stopReason = 'usage_unknown'; break }
      if (manifest.prices && spentUsd > manifest.caps.batch.maxCostUsd) { stopReason = 'batch_cost_cap_exceeded'; break }
    }
  } finally { await runHandle.close() }

  // 独立判分只读取已保存的预测，不接触 Agent 的会话或容器；每批使用新的 run_id。
  const scores: SwebenchScores = { runIds: {}, results: [] }
  for (const arm of manifest.arms.filter(candidate => batchManifest.arms.includes(candidate.id))) {
    if (!records.some(record => record.armId === arm.id)) continue
    const runId = `${sanitizeName(options.batchId)}-${sanitizeName(arm.id)}`
    scores.runIds[arm.id] = runId
    const predictions: SwebenchPrediction[] = await Promise.all(records.filter(record => record.armId === arm.id).map(async record => ({
      instance_id: record.instanceId, model_name_or_path: `mini-dsh-${sanitizeName(arm.id)}`,
      model_patch: await fs.readFile(path.join(options.evidenceRoot, record.patchPath), 'utf8') })))
    try {
      if (options.scoring === 'official') {
        const scoredInstances = batchManifest.instances.filter(instance => predictions.some(prediction => prediction.instance_id === instance.instance_id))
        scores.results.push(...await officialScores(options, arm, predictions, scoredInstances, runId, scoringRows!))
      } else {
        const score = options.scoreMock ?? await fixtureScorer(options.fixtureRoot!)
        for (const prediction of predictions) {
          const instance = instances.get(prediction.instance_id)!
          const target = path.join(options.evidenceRoot, 'scored', sanitizeName(arm.id), sanitizeName(instance.instance_id))
          const result = await trace(prediction, path.join(options.fixtureRoot!, instance.instance_id), target, score, instance)
          scores.results.push({ armId: arm.id, instanceId: instance.instance_id, resolved: result.resolved,
            classification: result.classification === 'empty' ? 'empty' : result.resolved ? 'resolved' : 'unresolved', scoreRunId: runId })
        }
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      stopReason = stopReason ?? 'scoring_failed'
      for (const prediction of predictions) {
        if (scores.results.some(result => result.armId === arm.id && result.instanceId === prediction.instance_id)) continue
        scores.results.push({ armId: arm.id, instanceId: prediction.instance_id, resolved: false, classification: 'error', scoreRunId: runId, rawPath: message.slice(0, 500) })
      }
    }
  }
  for (const record of records) record.resolved = scores.results.some(result => result.armId === record.armId && result.instanceId === record.instanceId && result.resolved)
  // 判分完成后重写 runs.jsonl，让 resolved 与原始证据同处一份记录；前面的追加只用于中断时保留现场。
  await fs.writeFile(path.join(options.evidenceRoot, 'runs.jsonl'), records.map(record => JSON.stringify(record) + '\n').join(''))
  await fs.writeFile(path.join(options.evidenceRoot, 'scores.json'), JSON.stringify(scores, null, 2) + '\n')
  const finishedAt = new Date().toISOString()
  const batch = { split: options.split, ...(stopReason ? { stopReason } : {}), spentUsdEstimate: Number(spentUsd.toFixed(9)), unknownCostEpisodes, startedAt, finishedAt }
  await fs.writeFile(path.join(options.evidenceRoot, 'batch.json'), JSON.stringify(batch, null, 2) + '\n')
  for (const record of records) if (record.eventsPath && record.sessionId) record.components = await readComponentMetrics(options.evidenceRoot, record)
  const report = buildReport(manifest, options.split, records, scores, batch)
  await writeReport(options.evidenceRoot, report)
  await writeChecksums(options.evidenceRoot)
  return report
}

async function fixtureScorer(root: string) {
  const scorerPath = path.join(root, 'score.mjs')
  const module = await import(pathToFileURL(scorerPath).href) as { default?: (workspace: string) => boolean | Promise<boolean> }
  if (typeof module.default !== 'function') throw new Error(`mock scorer ${scorerPath} must default-export a function`)
  return (_instance: SwebenchInstance, workspace: string) => module.default!(workspace)
}

async function writeChecksums(root: string) {
  const names = ['manifest.json', 'dataset.json', 'runs.jsonl', 'scores.json', 'batch.json', 'report.json']
  if (await fs.stat(path.join(root, 'environment-preflight.json')).then(() => true, () => false)) names.push('environment-preflight.json')
  const lines: string[] = []
  for (const name of names) {
    const bytes = await fs.readFile(path.join(root, name))
    lines.push(`${createHash('sha256').update(bytes).digest('hex')}  ${name}`)
  }
  await fs.writeFile(path.join(root, 'SHA256SUMS'), lines.join('\n') + '\n')
}

function argument(name: string) {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  if (!value || value.startsWith('--')) throw new Error(`missing ${name}`)
  return value
}

function optionalArgument(name: string) {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  return argument(name)
}

async function cli() {
  const execute = process.argv.includes('--execute')
  const validateOnly = process.argv.includes('--validate-only')
  if (execute === validateOnly) throw new Error('choose exactly one of --execute or --validate-only (zero model calls)')
  const manifestPath = path.resolve(argument('--manifest'))
  const manifest = validateRunManifest(JSON.parse(await fs.readFile(manifestPath, 'utf8')))
  const split = argument('--split')
  if (split !== 'development' && split !== 'formal') throw new Error('--split must be development or formal')
  const backend = argument('--backend')
  if (backend !== 'fixture' && backend !== 'docker') throw new Error('--backend must be fixture or docker')
  const scoring = argument('--scoring')
  if (scoring !== 'mock' && scoring !== 'official') throw new Error('--scoring must be mock or official')
  const report = await runSwebenchBatch({ manifest, manifestPath, datasetPath: path.resolve(argument('--dataset')),
    evidenceRoot: path.resolve(argument('--evidence-root')), split, backend, scoring, validateOnly,
    batchId: argument('--batch-id'), ...(optionalArgument('--fixtures') ? { fixtureRoot: path.resolve(argument('--fixtures')) } : {}),
    ...(optionalArgument('--scoring-dataset') ? { scoringDataset: path.resolve(argument('--scoring-dataset')) } : {}),
    ...(optionalArgument('--external-python') ? { externalPython: argument('--external-python') } : {}),
    ...(process.argv.includes('--resume') ? { resume: true } : {}) })
  console.log(JSON.stringify({ split, ...(validateOnly ? { validationOnly: true, paidRequests: 0 } : {}), executed: report.executedEpisodes, planned: report.plannedEpisodes,
    stopReason: report.batch.stopReason ?? null, perArm: report.perArm.map(arm => ({ armId: arm.armId, resolved: arm.resolved, planned: arm.planned, executed: arm.executed })) }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void cli().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
