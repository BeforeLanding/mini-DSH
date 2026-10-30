import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { childEnvironment, temporaryChildHome } from '../../src/core/child-environment.js'
import { externalLabels, renderExternalArgv } from './external-contract.js'
import type { ExternalPlaceholder } from './external-contract.js'
import {
  classifyExternalStatus, containsSecret, externalBudgetExceeded, externalCost, externalExitStatus, externalLitellmModel,
  externalOverrideConfig, externalDatasetRow, readBounded, readExternalPrediction, readExternalTrajectory,
  readExternalUsage, redactSecrets, writeExternalConfig, writeExternalDataset, probeExternalDataset,
} from './external.js'
import type { ExternalCaps, ExternalUsageReading } from './external.js'
import type { EpisodeStatus, PriceSnapshot, SwebenchArm, SwebenchInstance, SwebenchRunManifest } from './protocol.js'
import { removeContainersByLabel } from './workspace.js'
import { fingerprintBaseline } from './external-fingerprint.js'
import type { CommandEnvironment } from './command-environment.js'

export interface ExternalEpisodeRequest {
  arm: SwebenchArm
  instance: SwebenchInstance
  image: string
  workspace: string
  episodeDirectory: string
  batchId: string
  index: number
  caps: ExternalCaps
  prices: PriceSnapshot | null
  python: string
  upstreamConfigPath: string
  upstreamConfigSha256: string
  model: string
  apiKeyEnv: string
  modelClass?: string
  modelExtra?: Record<string, unknown>
  timeoutMs?: number
  commandEnvironment?: CommandEnvironment
}

export interface ExternalEpisodeEvidence {
  command: string[]
  datasetPath: string
  datasetSha256: string
  configPath: string
  configSha256: string
  upstreamConfigPath: string
  upstreamConfigSha256: string
  stdoutPath: string
  stderrPath: string
  trajectoryPath?: string
  predictionPath?: string
  logPath?: string
  resultPath: string
  exitCode: number | null
  signal: string | null
  durationMs: number
  maxTotalTokens: number
  miniExitStatus: string | null
  miniApiCalls: number | null
  miniReportedCostUsd: number | null
  actions: number
  usageReasons: string[]
  containerIds: string[]
  containerEnvNames: string[]
  removedContainerIds: string[]
  leftoverContainerIds: string[]
  secretLeak: boolean
}

export interface ExternalEpisodeOutcome {
  status: EpisodeStatus
  patch: string
  error?: string
  costUsd?: number
  usageUnknown: boolean
  counters: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    modelRequests: number
    toolCalls: number
    activeDurationMs: number
  }
  external: ExternalEpisodeEvidence
}

export interface ExternalDependencies {
  spawn?: typeof spawn
  prepareDataset?: (input: { python: string; directory: string; row: Record<string, string> }) => Promise<{ file: string; sha256: string }>
  probeDataset?: (input: { python: string; directory: string; instanceId: string }) => Promise<void>
  containerIds?: (label: string) => string[]
  containerEnv?: (id: string) => string[]
  removeByLabel?: (label: string) => { removed: string[]; remaining: string[] }
  killTree?: (child: ChildProcess, signal: NodeJS.Signals) => void
  now?: () => number
}

function dockerContainerIds(label: string): string[] {
  const result = spawnSync('docker', ['ps', '-aq', '--filter', `label=${label}`], { encoding: 'utf8', timeout: 30_000 })
  if (result.status !== 0) throw new Error(`could not list external containers: ${result.stderr ?? ''}`)
  return (result.stdout ?? '').split('\n').filter(Boolean)
}

function dockerContainerEnv(id: string): string[] {
  const result = spawnSync('docker', ['inspect', id], { encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })
  if (result.status !== 0) return []
  try {
    const parsed = JSON.parse(result.stdout ?? '[]') as Array<{ Config?: { Env?: string[] } }>
    return parsed[0]?.Config?.Env ?? []
  } catch {
    return []
  }
}

function killTree(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.pid === undefined) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { timeout: 10_000 })
    return
  }
  try { process.kill(-child.pid, signal) } catch { try { child.kill(signal) } catch { /* already gone */ } }
}

function redactKnownSecrets(text: string, secrets: readonly string[]): string {
  return redactSecrets(text, secrets)
}

export async function runExternalEpisode(request: ExternalEpisodeRequest, dependencies: ExternalDependencies = {}): Promise<ExternalEpisodeOutcome> {
  const arm = request.arm
  const command = arm.external?.command
  if (!command) throw new Error(`external arm ${arm.id} has no frozen command`)
  const labels = externalLabels({ batchId: request.batchId, instanceId: request.instance.instance_id, armId: arm.id, index: request.index })
  const model = request.model || externalLitellmModel(arm)
  const externalDirectory = path.join(request.episodeDirectory, 'external')
  const datasetDirectory = path.join(externalDirectory, 'dataset')
  const outputDirectory = path.join(externalDirectory, 'output')
  const configPath = path.join(externalDirectory, 'config.episode.yaml')
  const stdoutPath = path.join(externalDirectory, 'stdout.log')
  const stderrPath = path.join(externalDirectory, 'stderr.log')
  const resultPath = path.join(externalDirectory, 'result.json')
  const liveTrajectory = path.join(outputDirectory, 'live.traj.json')
  const now = dependencies.now ?? (() => Date.now())
  const spawnChild = dependencies.spawn ?? spawn
  const containerIds = dependencies.containerIds ?? dockerContainerIds
  const containerEnv = dependencies.containerEnv ?? dockerContainerEnv
  const removeByLabel = dependencies.removeByLabel ?? removeContainersByLabel
  const kill = dependencies.killTree ?? killTree
  const keyName = request.apiKeyEnv
  const keyValue = process.env[keyName]
  if (!keyValue) throw new Error(`missing provider credential environment variable ${keyName}`)
  const secrets = [keyValue]
  const uid = process.getuid?.(), gid = process.getgid?.()
  if (uid === undefined || gid === undefined) throw new Error('external baseline requires a POSIX uid/gid')

  await fs.mkdir(outputDirectory, { recursive: true })
  await fs.mkdir(path.join(externalDirectory, 'hf-home'), { recursive: true })
  // A previous crashed attempt may have left containers with this episode label.
  const stale = containerIds(`mini-dsh.external.episode=${labels.episode}`)
  if (stale.length) removeByLabel(`mini-dsh.external.episode=${labels.episode}`)

  const row = externalDatasetRow(request.instance, request.image)
  const dataset = await (dependencies.prepareDataset ?? writeExternalDataset)({ python: request.python, directory: datasetDirectory, row })
  await (dependencies.probeDataset ?? probeExternalDataset)({ python: request.python, directory: datasetDirectory, instanceId: request.instance.instance_id })
  const config = externalOverrideConfig({ model, caps: request.caps, paths: {
    episodeDirectory: request.episodeDirectory, workspace: request.workspace, datasetDirectory, configPath, outputDirectory,
    upstreamConfigPath: request.upstreamConfigPath,
  }, uid, gid, labels, modelClass: request.modelClass, modelExtra: request.modelExtra, commandEnvironment: request.commandEnvironment })
  const written = await writeExternalConfig(configPath, config)
  const values: Record<ExternalPlaceholder, string> = {
    python: request.python, dataset: datasetDirectory, config: configPath, output: outputDirectory,
    workspace: request.workspace, instance: request.instance.instance_id, image: request.image, model,
    upstream_config: request.upstreamConfigPath,
  }
  const argv = renderExternalArgv(command, values)
  const home = await temporaryChildHome()
  const additions: NodeJS.ProcessEnv = {
    [keyName]: keyValue,
    PYTHONUNBUFFERED: '1', NO_COLOR: '1', TERM: 'dumb',
    HF_HOME: path.join(externalDirectory, 'hf-home'), HF_HUB_OFFLINE: '1', HF_DATASETS_OFFLINE: '1',
  }
  if (process.env.DEEPSEEK_BASE_URL) additions.DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL
  const env = childEnvironment(home, additions)

  const stdout = await fs.open(stdoutPath, 'a')
  const stderr = await fs.open(stderrPath, 'a')
  const started = now()
  let killedBy: 'wall_clock' | 'cost' | 'tool_calls' | 'requests' | 'token_budget' | 'cancelled' | null = null
  let child: ChildProcess
  try {
    child = spawnChild(argv[0]!, argv.slice(1), { cwd: externalDirectory, env, detached: process.platform !== 'win32', stdio: ['ignore', stdout.fd, stderr.fd] })
  } catch (error) {
    await stdout.close(); await stderr.close(); await fs.rm(home, { recursive: true, force: true })
    throw error
  }
  const close = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  const killOnce = (reason: NonNullable<typeof killedBy>) => {
    if (killedBy) return
    killedBy = reason
    kill(child, 'SIGTERM')
    setTimeout(() => { if (child.exitCode === null && !child.killed) kill(child, 'SIGKILL') }, 5_000).unref()
  }
  const watchdog = setInterval(async () => {
    if (killedBy) return
    const elapsed = now() - started
    if (elapsed >= request.caps.wallClockMs) { killOnce('wall_clock'); return }
    const text = await readBounded(liveTrajectory, 8 * 1024 * 1024)
    if (!text) return
    try {
      const reading = readExternalUsage(JSON.parse(text))
      const exhausted = externalBudgetExceeded(reading, request.caps, request.prices)
      if (exhausted) killOnce(exhausted)
    } catch { /* a partially written live trajectory is expected */ }
  }, 2_000)
  const hardTimer = setTimeout(() => killOnce('wall_clock'), request.timeoutMs ?? (request.caps.wallClockMs + 120_000))
  let closed: { code: number | null; signal: string | null }
  try {
    closed = await close
  } finally {
    clearInterval(watchdog)
    clearTimeout(hardTimer)
    await stdout.close()
    await stderr.close()
  }
  const durationMs = Math.max(0, now() - started)

  // Inspect the labeled containers before removing them: the provider key must
  // never appear in a container environment.
  let containerIdsFound: string[] = []
  const containerEnvNames: string[] = []
  let secretLeak = false
  let removedContainerIds: string[] = []
  let leftoverContainerIds: string[] = []
  try {
    containerIdsFound = containerIds(`mini-dsh.external.episode=${labels.episode}`)
    for (const id of containerIdsFound) {
      const values = containerEnv(id)
      containerEnvNames.push(...values.map(value => value.split('=')[0] ?? 'unknown'))
      if (values.some(value => value.includes(keyValue) || value.startsWith(`${keyName}=`))) secretLeak = true
    }
    const removed = removeByLabel(`mini-dsh.external.episode=${labels.episode}`)
    removedContainerIds = removed.removed
    leftoverContainerIds = removed.remaining
  } catch {
    leftoverContainerIds = containerIdsFound
  }
  await fs.rm(home, { recursive: true, force: true })

  const trajectoryReading = await readExternalTrajectory(outputDirectory, request.instance.instance_id)
  const liveReading = trajectoryReading.trajectory === undefined
    ? await (async () => { const text = await readBounded(liveTrajectory, 16 * 1024 * 1024); if (!text) return undefined; try { return JSON.parse(text) } catch { return undefined } })()
    : undefined
  const trajectory = trajectoryReading.trajectory ?? liveReading
  const prediction = await readExternalPrediction(outputDirectory, request.instance.instance_id)
  const miniExitStatus = externalExitStatus(trajectory)
  const usageReading = trajectory === undefined
    ? { usage: [], inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, modelRequests: 0, toolCalls: 0, miniApiCalls: null, reportedCostUsd: null, unknown: true, reasons: [trajectoryReading.reasons[0] ?? 'no trajectory'] } as ExternalUsageReading
    : readExternalUsage(trajectory)
  const usageCost = externalCost(usageReading, request.prices)
  let status = classifyExternalStatus({ miniExitStatus, exitCode: closed.code, timedOut: killedBy === 'wall_clock', killedBy: killedBy === 'wall_clock' ? null : killedBy })
  if (killedBy === 'wall_clock') status = 'timeout'
  if (killedBy === 'cancelled') status = 'cancelled'
  const reasons: string[] = [...trajectoryReading.reasons, ...prediction.reasons, ...usageReading.reasons]
  if (trajectory === undefined) status = 'infrastructure'
  if (miniExitStatus === 'Submitted' && prediction.prediction === undefined) status = 'infrastructure'
  if (secretLeak) { status = 'infrastructure'; reasons.push('provider credential found in container environment') }
  if (leftoverContainerIds.length) { status = 'infrastructure'; reasons.push('external container cleanup left containers behind') }
  const patch = prediction.prediction?.model_patch ?? ''
  if (usageReading.inputTokens + usageReading.outputTokens > request.caps.maxTotalTokens && status === 'completed') {
    status = 'budget'
    reasons.push(`provider usage ${usageReading.inputTokens + usageReading.outputTokens} tokens exceeded the shared per-task cap ${request.caps.maxTotalTokens}`)
  }
  if (usageCost.costUsd !== undefined && usageCost.costUsd > request.caps.maxCostUsd && status === 'completed') {
    status = 'budget'
    reasons.push(`provider usage cost ${usageCost.costUsd.toFixed(6)} exceeded the per-task cap`)
  }

  // Redact the key from every text artifact. Read the full file so a leak
  // beyond the bounded preview is not left behind.
  const logPath = path.join(outputDirectory, 'minisweagent.log')
  for (const file of [stdoutPath, stderrPath, prediction.path, trajectoryReading.path, logPath]) {
    const text = await fs.readFile(file, 'utf8').catch(() => '')
    if (!text || !containsSecret(text, secrets)) continue
    await fs.writeFile(file, redactKnownSecrets(text, secrets), 'utf8')
    secretLeak = true
    status = 'infrastructure'
    reasons.push(`provider credential found in ${path.basename(file)}; artifact redacted`)
  }
  const logExists = await fs.stat(logPath).then(stat => stat.isFile()).catch(() => false)

  const evidence: ExternalEpisodeEvidence = {
    command: argv, datasetPath: dataset.file, datasetSha256: dataset.sha256, configPath, configSha256: written.sha256,
    upstreamConfigPath: request.upstreamConfigPath, upstreamConfigSha256: request.upstreamConfigSha256,
    stdoutPath, stderrPath, ...(trajectoryReading.trajectory !== undefined ? { trajectoryPath: trajectoryReading.path } : {}),
    ...(prediction.prediction !== undefined ? { predictionPath: prediction.path } : {}),
    ...(logExists ? { logPath } : {}), resultPath,
    exitCode: closed.code, signal: closed.signal, durationMs, maxTotalTokens: request.caps.maxTotalTokens,
    miniExitStatus, miniApiCalls: usageReading.miniApiCalls,
    miniReportedCostUsd: usageReading.reportedCostUsd, actions: usageReading.toolCalls, usageReasons: usageReading.reasons,
    containerIds: containerIdsFound, containerEnvNames, removedContainerIds, leftoverContainerIds, secretLeak,
  }
  const outcome: ExternalEpisodeOutcome = {
    status, patch, ...(reasons.length ? { error: reasons.slice(0, 12).join('; ') } : {}),
    ...(usageCost.costUsd === undefined ? {} : { costUsd: usageCost.costUsd }),
    usageUnknown: usageCost.unknown,
    counters: {
      inputTokens: usageReading.inputTokens, outputTokens: usageReading.outputTokens, cacheReadTokens: usageReading.cacheReadTokens,
      modelRequests: usageReading.modelRequests, toolCalls: usageReading.toolCalls, activeDurationMs: durationMs,
    },
    external: evidence,
  }
  await fs.writeFile(resultPath, JSON.stringify(outcome, null, 2) + '\n', { mode: 0o600 })
  return outcome
}

export interface ExternalPreflight {
  python: string
  upstreamConfigPath: string
  upstreamConfigSha256: string
  version: string
  installSha256: string
  model: string
  apiKeyEnv: string
}

// Runs before the evidence directory exists. It verifies the frozen install
// fingerprint, the provider key's presence (name only), Docker/uid, the pinned
// images, and that a one-row sanitized dataset can be written and loaded. It
// does not start a container or call a model.
export async function preflightExternal(input: {
  manifest: SwebenchRunManifest
  split: 'development' | 'formal'
  instances: readonly SwebenchInstance[]
  images: Record<string, string>
  python: string
}): Promise<ExternalPreflight> {
  const arm = input.manifest.arms.find(value => value.system === 'external')
  if (!arm?.external) throw new Error('the split has an external arm but the manifest has no external contract')
  const external = arm.external
  if (!external.apiKeyEnv || !process.env[external.apiKeyEnv]) throw new Error(`missing provider credential environment variable ${external.apiKeyEnv ?? '(unset)'}`)
  if (process.getuid?.() === undefined || process.getgid?.() === undefined) throw new Error('external baseline requires a POSIX uid/gid')
  const docker = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', timeout: 30_000 })
  if (docker.status !== 0) throw new Error(`Docker is not available: ${(docker.stderr ?? '').slice(-500)}`)
  const fingerprint = fingerprintBaseline(input.python)
  if (external.version && external.version !== fingerprint.version) throw new Error(`baseline version mismatch: manifest ${external.version}, installed ${fingerprint.version}`)
  if (external.upstreamConfigSha256 && external.upstreamConfigSha256 !== fingerprint.upstreamConfigSha256) throw new Error('baseline upstream config hash does not match the frozen manifest')
  if (external.installSha256 && external.installSha256 !== fingerprint.installSha256) throw new Error('baseline install fingerprint does not match the frozen manifest')
  if (external.commit && fingerprint.vcsCommit && !fingerprint.vcsCommit.startsWith(external.commit)) throw new Error(`baseline git commit mismatch: manifest ${external.commit}, installed ${fingerprint.vcsCommit}`)
  if (!arm.model.name) throw new Error('external arm needs a model name')
  const model = external.modelName ?? `${arm.model.provider}/${arm.model.name}`
  if (model !== `${arm.model.provider}/${arm.model.name}`) throw new Error('external modelName must be provider/model')
  const missingImages = [...new Set(input.instances.map(instance => input.images[instance.instance_id]).filter((value): value is string => !!value))]
    .filter(image => spawnSync('docker', ['image', 'inspect', image], { encoding: 'utf8', timeout: 60_000 }).status !== 0)
  if (missingImages.length) throw new Error(`pinned task images are not present locally: ${missingImages.slice(0, 5).join(', ')}${missingImages.length > 5 ? ` (+${missingImages.length - 5})` : ''}`)
  const first = input.instances[0]
  const image = first ? input.images[first.instance_id] : undefined
  if (!first || !image) throw new Error(`the ${input.split} split has no instance with an image digest`)
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-external-preflight-'))
  try {
    await writeExternalDataset({ python: input.python, directory: temporary, row: externalDatasetRow(first, image) })
    await probeExternalDataset({ python: input.python, directory: temporary, instanceId: first.instance_id })
  } finally {
    await fs.rm(temporary, { recursive: true, force: true })
  }
  return { python: input.python, upstreamConfigPath: fingerprint.configPath, upstreamConfigSha256: fingerprint.upstreamConfigSha256,
    version: fingerprint.version, installSha256: fingerprint.installSha256, model, apiKeyEnv: external.apiKeyEnv }
}
