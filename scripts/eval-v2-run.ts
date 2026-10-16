import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import dotenv from 'dotenv'
import { createDeepSeekAdapter } from '../src/models/deepseek.js'
import { emptyCounters } from '../src/core/budget.js'
import { decodeLog } from '../src/core/event-store.js'
import type { SessionEvent } from '../src/core/contracts.js'
import { runFixtureTask } from './eval-fixture.js'
import type { RunOutcome } from './eval-runner.js'
import { deriveV2Observation, recoverV2UnverifiedEvents } from './eval-v2-observation.js'
import { createIsolatedCommandRunner, windowsToWslPath } from './eval-v2-isolation.js'
import { reportV2, verifyV2FrozenFiles } from './eval-v2-report.js'
import type { V2Manifest, V2Observation } from './eval-v2-report.js'

const args = process.argv.slice(2)
const validateOnly = args.length === 3 && args[0] === '--manifest' && args[2] === '--validate-only'
if (!validateOnly && (args.length !== 7 || args[0] !== '--manifest' || args[2] !== '--evidence-root' || args[4] !== '--max-usd' || args[6] !== '--execute')) {
  throw new Error('usage: eval:v2-run --manifest FILE --evidence-root NEW_DIRECTORY --max-usd POSITIVE_NUMBER --execute; or --manifest FILE --validate-only')
}
const manifest = JSON.parse(await fs.readFile(args[1]!, 'utf8')) as V2Manifest
const evidenceRoot = path.resolve(args[3] ?? os.tmpdir())
const maxUsd = validateOnly ? 0 : Number(args[5])
if (!validateOnly && (!Number.isFinite(maxUsd) || maxUsd <= 0)) throw new Error('--max-usd must be a positive finite amount')
if (manifest.priceSnapshot.currency !== 'USD') throw new Error('this runner requires a USD price snapshot for --max-usd')
if (![manifest.priceSnapshot.inputPerMillion, manifest.priceSnapshot.outputPerMillion, manifest.priceSnapshot.cacheReadPerMillion].every(value => Number.isFinite(value) && value >= 0) ||
  manifest.priceSnapshot.inputPerMillion === 0 || manifest.priceSnapshot.outputPerMillion === 0) throw new Error('invalid frozen price snapshot')
if (!manifest.model.startsWith('deepseek/')) throw new Error('only a frozen deepseek model is supported')
if (manifest.split !== 'calibration' && manifest.split !== 'formal') throw new Error('invalid V2 split')
reportV2(manifest, []) // Validate the entire fixed task, arm and episode schedule before side effects.
await verifyV2FrozenFiles(manifest)
if (!validateOnly && await fs.stat(evidenceRoot).catch(() => undefined)) throw new Error(`evidence root already exists: ${evidenceRoot}`)
const runtimeRoot = process.env.MINI_DSH_V2_RUNTIME
if (!runtimeRoot || !(await fs.stat(runtimeRoot).catch(() => undefined))?.isDirectory()) throw new Error('MINI_DSH_V2_RUNTIME must point to the pinned extracted Linux runtime')
const preflight = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-v2-preflight-'))
try {
  const sentinel = path.join(path.dirname(preflight), `${path.basename(preflight)}-hidden.txt`)
  await fs.writeFile(sentinel, 'host-only', { flag: 'wx' })
  try {
    const result = await createIsolatedCommandRunner({ workspace: preflight, runtimeRoot, distro: 'Ubuntu' })({
      executable: 'ignored', args: [], command: `node --version && test ! -r '${windowsToWslPath(sentinel)}'`, cwd: preflight,
      signal: new AbortController().signal, timeoutMs: 10_000,
    })
    if (result.status !== 'exited' || result.exitCode !== 0 || !result.stdout.text.includes('v22.22.1')) throw new Error('V2 Linux isolation preflight failed')
  } finally { await fs.rm(sentinel, { force: true }) }
} finally {
  if (path.dirname(preflight) === path.resolve(os.tmpdir()) && path.basename(preflight).startsWith('mini-dsh-v2-preflight-')) await fs.rm(preflight, { recursive: true, force: true })
}
if (validateOnly) {
  console.log(JSON.stringify({ manifestDigest: manifest.digest, tasks: manifest.tasks.length, episodes: manifest.episodes.length, isolation: 'passed', paidRequests: 0 }))
  process.exit(0)
}
dotenv.config({ quiet: true })
if (!process.env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY is required for a paid V2 batch')
const modelId = manifest.model.slice('deepseek/'.length)
const adapter = createDeepSeekAdapter({ baseUrl: manifest.baseUrl, models: [modelId], thinking: manifest.thinking, contextWindowTokens: manifest.window })
const armByName = new Map(manifest.arms.map(arm => [arm.name, arm]))
const maxUnit = Math.max(manifest.priceSnapshot.inputPerMillion, manifest.priceSnapshot.outputPerMillion, manifest.priceSnapshot.cacheReadPerMillion)
const perEpisodeReserve = (manifest.tier === '2m' ? 2_000_000 : 1_000_000) * maxUnit / 1_000_000 * 1.1
const blockSize = manifest.split === 'formal' ? 4 : 2
const probeReserve = 16_384 * maxUnit / 1_000_000
if (maxUsd < probeReserve + perEpisodeReserve * blockSize) throw new Error(`amount cap cannot reserve protocol probes and one complete block; need at least $${(probeReserve + perEpisodeReserve * blockSize).toFixed(2)}`)

await fs.mkdir(evidenceRoot)
await fs.writeFile(path.join(evidenceRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
const runLog = path.join(evidenceRoot, 'runs.jsonl')
await fs.writeFile(runLog, '', { flag: 'wx' })
const observations: V2Observation[] = []
let spentUsd = 0
let stopped = false
let stopReason = ''

try {
  const response = await fetch(`${manifest.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: modelId, max_tokens: 16, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: 'reply with the single word: ok' }] }),
    signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok) throw new Error(`model probe failed: HTTP ${response.status}`)
  const direct = await response.json() as { model?: string; usage?: unknown; choices?: { finish_reason?: string }[] }
  if (direct.model !== manifest.echoedModel || !direct.usage) throw new Error(`model probe mismatch: expected ${manifest.echoedModel}, observed ${String(direct.model)}`)
  const streamed = await adapter.chat({ model: modelId, maxOutputTokens: 1024, messages: [{ role: 'user', content: 'reply with the single word: ok' }] })
  if (!streamed.usage || streamed.complete === false) throw new Error('streaming model probe returned no complete usage')
  await fs.writeFile(path.join(evidenceRoot, 'probe.json'), `${JSON.stringify({ requestedModel: modelId, echoedModel: direct.model, directUsage: direct.usage, directFinishReason: direct.choices?.[0]?.finish_reason, streamedUsage: streamed.usage, streamedFinishReason: streamed.finishReason, reservedUsd: probeReserve }, null, 2)}\n`, { flag: 'wx' })
  // Reserve the full probe allowance in the amount ceiling; actual provider prices may be lower.
  spentUsd = probeReserve
} catch (error) {
  await fs.writeFile(path.join(evidenceRoot, 'probe-error.json'), `${JSON.stringify({ error: error instanceof Error ? error.message : String(error), reserveUsd: probeReserve })}\n`, { flag: 'wx' })
  await fs.writeFile(path.join(evidenceRoot, 'report.json'), `${JSON.stringify({ ...reportV2(manifest, []), stopped: true, stopReason: 'protocol_probe_failed', spentUsdEstimate: probeReserve, maxUsd }, null, 2)}\n`, { flag: 'wx' })
  throw error
}

async function readDurableEvents(directory: string): Promise<SessionEvent[]> {
  const dirs = await fs.readdir(directory, { withFileTypes: true })
  if (dirs.length !== 1 || !dirs[0]!.isDirectory()) throw new Error('expected one durable session per V2 episode')
  const sessionId = dirs[0]!.name
  return decodeLog(await fs.readFile(path.join(directory, sessionId, 'events.jsonl')), sessionId)
}

function recoverPartialOutcome(events: readonly SessionEvent[], reason: string): RunOutcome {
  const counters = emptyCounters()
  for (const event of events) {
    if (event.type === 'model/start') counters.modelRequests += 1
    if (event.type === 'model/usage') {
      counters.inputTokens += event.data.usage.inputTokens
      counters.outputTokens += event.data.usage.outputTokens
      counters.totalTokens += event.data.usage.totalTokens
      counters.cacheReadTokens += event.data.usage.cacheReadTokens ?? 0
    }
    if (event.type === 'tool/start') counters.toolCalls += 1
    if (event.type === 'tool/result' && event.data.isError && event.data.status !== 'skipped') counters.toolErrors += 1
  }
  return { status: 'error', counters, accepted: null, error: reason }
}

for (let index = 0; index < manifest.episodes.length; index += blockSize) {
  const block = manifest.episodes.slice(index, index + blockSize)
  if (block.length !== blockSize || new Set(block.map(episode => `${episode.taskId}/${episode.repeat}`)).size !== 1) throw new Error(`invalid V2 paired block at ${index}`)
  if (spentUsd + perEpisodeReserve * blockSize > maxUsd) { stopped = true; stopReason = 'amount_cap_before_complete_block'; break }
  for (const [withinBlock, episode] of block.entries()) {
    const arm = armByName.get(episode.arm)
    if (!arm) throw new Error(`missing frozen arm: ${episode.arm}`)
    const episodeDirectory = path.join(evidenceRoot, 'episodes', `${String(index + withinBlock).padStart(3, '0')}-${episode.taskId}-${episode.repeat}-${episode.arm}`)
    await fs.mkdir(episodeDirectory, { recursive: true })
    const sessionDirectory = path.join(episodeDirectory, 'sessions')
    let outcome: RunOutcome
    let events: SessionEvent[] = []
    let evidenceComplete = false
    try {
      const result = await runFixtureTask(episode.taskId as Parameters<typeof runFixtureTask>[0],
        () => ({ provider: 'deepseek', model: modelId, capabilities: adapter.capabilities, chat: adapter.chat }),
        arm.budget, sessionDirectory, arm.toolOutput, arm.promptLayout, path.join(episodeDirectory, 'snapshots'), { runtimeRoot, distro: 'Ubuntu' })
      outcome = result
      events = await readDurableEvents(sessionDirectory)
      evidenceComplete = result.episode?.stages.length === (manifest.tasks.find(task => task.id === episode.taskId)?.shape === 'multi-stage' ? 4 : 1)
        && result.episode.stages.every(stage => Boolean(stage.snapshotHash))
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      try { events = await readDurableEvents(sessionDirectory) } catch {
        try {
          const dirs = await fs.readdir(sessionDirectory, { withFileTypes: true })
          if (dirs.length === 1 && dirs[0]!.isDirectory()) events = recoverV2UnverifiedEvents(await fs.readFile(path.join(sessionDirectory, dirs[0]!.name, 'events.jsonl'), 'utf8'))
        } catch { /* Missing journal: provider charges may remain unknown. */ }
      }
      await fs.writeFile(path.join(episodeDirectory, 'error.json'), `${JSON.stringify({ reason, recoveredEvents: events.length })}\n`, { flag: 'wx' })
      outcome = recoverPartialOutcome(events, reason)
      stopped = true
      stopReason = 'infrastructure_or_evidence_error'
    }
    const observation = deriveV2Observation(episode, outcome, events, evidenceComplete)
    if (observation.failureReason === 'infrastructure' || observation.status === 'error') {
      if (!stopped) {
        await fs.writeFile(path.join(episodeDirectory, 'error.json'), `${JSON.stringify({
          kind: 'provider_or_runtime_error',
          providerHttpStatus: observation.providerHttpStatus ?? null,
        })}\n`, { flag: 'wx' })
        stopReason = 'infrastructure_or_provider_error'
      }
      stopped = true
    }
    observations.push(observation)
    await fs.appendFile(runLog, `${JSON.stringify(observation)}\n`)
    const tokens = observation.metrics
    const nonCacheInput = Math.max(0, tokens.inputTokens - tokens.cacheReadTokens)
    spentUsd += (nonCacheInput * manifest.priceSnapshot.inputPerMillion + tokens.cacheReadTokens * manifest.priceSnapshot.cacheReadPerMillion + tokens.outputTokens * manifest.priceSnapshot.outputPerMillion) / 1_000_000
    if (spentUsd > maxUsd) { stopped = true; stopReason = 'amount_cap_exceeded_after_provider_usage' }
    console.log(`${episode.taskId}/${episode.repeat}/${episode.arm}: ${observation.status}, accepted=${observation.accepted}, spent≈$${spentUsd.toFixed(4)}`)
    if (stopped) break
  }
  if (stopped) break
}

const report = reportV2(manifest, observations)
await fs.writeFile(path.join(evidenceRoot, 'report.json'), `${JSON.stringify({ ...report, spentUsdEstimate: spentUsd, maxUsd, stopped, stopReason }, null, 2)}\n`, { flag: 'wx' })
console.log(JSON.stringify({ evidenceRoot, executed: observations.length, planned: manifest.episodes.length, incomplete: report.incomplete, spentUsdEstimate: spentUsd, stopReason }))
if (report.incomplete || stopped) process.exitCode = 1
