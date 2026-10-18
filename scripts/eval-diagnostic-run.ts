import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { createDeepSeekAdapter } from '../src/models/deepseek.js'
import { estimateInput } from '../src/core/token-estimator.js'
import { emptyCounters } from '../src/core/budget.js'
import { decodeLog } from '../src/core/event-store.js'
import type { SessionEvent } from '../src/core/contracts.js'
import type { FixtureAdapter, Fixture } from './eval-fixture.js'
import { runFixtureTask } from './eval-fixture.js'
import { createIsolatedCommandRunner, windowsToWslPath } from './eval-v2-isolation.js'
import { createSmokeAmountGuard } from './smoke-cost.js'
import { diagnoseV2Error, recoverV2UnverifiedEvents } from './eval-v2-observation.js'
import { diagnosticReport, diagnosticReserve, diagnosticStopReason, freezeDiagnostic, observeDiagnostic, verifyDiagnosticManifest } from './eval-diagnostic-plan.js'
import type { DiagnosticConfig, DiagnosticEpisode, DiagnosticManifest, DiagnosticRecord } from './eval-diagnostic-plan.js'

const repository = fileURLToPath(new URL('../../', import.meta.url))
const git = (args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim()
const cleanHead = () => {
  if (git(['status', '--porcelain'])) throw new Error('NX-51 requires a clean checkout')
  return git(['rev-parse', 'HEAD'])
}

export async function preflightDiagnosticIsolation(runtimeRoot: string): Promise<void> {
  if (!(await fs.stat(runtimeRoot).catch(() => undefined))?.isDirectory()) throw new Error('MINI_DSH_V2_RUNTIME must name the pinned Linux runtime')
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'nx51-preflight-'))
  const sentinel = path.join(path.dirname(workspace), `${path.basename(workspace)}-hidden.txt`)
  try {
    await fs.writeFile(sentinel, 'host-only', { flag: 'wx' })
    const result = await createIsolatedCommandRunner({ workspace, runtimeRoot, distro: 'Ubuntu' })({
      executable: 'ignored', args: [], command: `node --version && test ! -r '${windowsToWslPath(sentinel)}'`, cwd: workspace,
      signal: new AbortController().signal, timeoutMs: 10_000,
    })
    if (result.status !== 'exited' || result.exitCode !== 0 || !result.stdout.text.includes('v22.22.1')) throw new Error('NX-51 Linux isolation preflight failed')
  } finally {
    await fs.rm(sentinel, { force: true })
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  }
}

async function durableEvents(directory: string): Promise<SessionEvent[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  if (entries.length !== 1 || !entries[0]!.isDirectory()) throw new Error('expected one durable session per diagnostic episode')
  return decodeLog(await fs.readFile(path.join(directory, entries[0]!.name, 'events.jsonl')), entries[0]!.name)
}

function partialOutcome(events: readonly SessionEvent[], reason: string): Awaited<ReturnType<typeof runFixtureTask>> {
  const counters = emptyCounters()
  for (const event of events) {
    if (event.type === 'model/start') counters.modelRequests++
    if (event.type === 'model/usage') {
      counters.inputTokens += event.data.usage.inputTokens; counters.outputTokens += event.data.usage.outputTokens
      counters.totalTokens += event.data.usage.totalTokens; counters.cacheReadTokens += event.data.usage.cacheReadTokens ?? 0
    }
    if (event.type === 'tool/start') counters.toolCalls++
    if (event.type === 'tool/result' && event.data.isError && event.data.status !== 'skipped') counters.toolErrors++
    if (event.type === 'tool/result' && event.data.previewTruncated) counters.previewTruncations++
  }
  return { status: 'error', counters, accepted: null, error: reason }
}

export async function executeDiagnosticEpisodes(options: {
  manifest: DiagnosticManifest; evidenceRoot: string; runtimeRoot: string
  makeAdapter: (episode: DiagnosticEpisode, fixture: Fixture) => FixtureAdapter
  mode: 'offline' | 'paid'; maxUsd?: number; spentUsd?: () => number
}): Promise<{ records: DiagnosticRecord[]; stopped: boolean; stopReason: string }> {
  const { manifest, evidenceRoot, runtimeRoot } = options
  if (await fs.stat(evidenceRoot).catch(() => undefined)) throw new Error('NX-51 evidence root already exists')
  await fs.mkdir(evidenceRoot)
  await fs.writeFile(path.join(evidenceRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
  const runLog = path.join(evidenceRoot, 'runs.jsonl')
  await fs.writeFile(runLog, '', { flag: 'wx' })
  const records: DiagnosticRecord[] = []
  let stopped = false, stopReason = ''
  const reserve = diagnosticReserve(manifest.priceSnapshot)
  for (let index = 0; index < manifest.episodes.length; index += 2) {
    const block = manifest.episodes.slice(index, index + 2)
    if (block.length !== 2 || block[0]!.block !== block[1]!.block || block[0]!.bytes !== block[1]!.bytes || block[0]!.repeat !== block[1]!.repeat) throw new Error('invalid NX-51 paired block')
    if (options.mode === 'paid' && (options.spentUsd?.() ?? 0) + reserve.perEpisodeUsd * 2 + reserve.probeUsd > options.maxUsd!) {
      stopped = true; stopReason = 'amount_cap_before_complete_block'; break
    }
    for (const episode of block) {
      const arm = manifest.arms.find(item => item.name === episode.arm)!
      const episodeDirectory = path.join(evidenceRoot, 'episodes', `${String(index + block.indexOf(episode)).padStart(3, '0')}-${episode.bytes}-${episode.repeat}-${episode.arm}`)
      const sessionDirectory = path.join(episodeDirectory, 'sessions')
      await fs.mkdir(episodeDirectory, { recursive: true })
      let localEstimatedInputTokens = 0, outcome: Awaited<ReturnType<typeof runFixtureTask>>, events: SessionEvent[] = [], evidenceComplete = false
      try {
        outcome = await runFixtureTask('BC01', fixture => {
          const adapter = options.makeAdapter(episode, fixture)
          return { ...adapter, chat: async request => {
            localEstimatedInputTokens += estimateInput(request)
            return adapter.chat(request)
          } }
        }, arm.budget, sessionDirectory, arm.toolOutput, arm.promptLayout, path.join(episodeDirectory, 'snapshots'),
        { runtimeRoot, distro: 'Ubuntu' }, { bytes: episode.bytes, repeat: episode.repeat })
        events = await durableEvents(sessionDirectory)
        evidenceComplete = outcome.episode?.stages.length === 1 && !!outcome.episode.stages[0]?.snapshotHash
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        try { events = await durableEvents(sessionDirectory) } catch {
          try {
            const entries = await fs.readdir(sessionDirectory, { withFileTypes: true })
            if (entries.length === 1 && entries[0]!.isDirectory()) events = recoverV2UnverifiedEvents(await fs.readFile(path.join(sessionDirectory, entries[0]!.name, 'events.jsonl'), 'utf8'))
          } catch { /* Missing journal may leave provider charges unknown. */ }
        }
        await fs.writeFile(path.join(episodeDirectory, 'error.json'), `${JSON.stringify(diagnoseV2Error(reason, events))}\n`, { flag: 'wx' })
        outcome = partialOutcome(events, reason)
        stopped = true; stopReason = 'infrastructure_or_evidence_error'
      }
      const record = observeDiagnostic(episode, outcome, events, evidenceComplete, localEstimatedInputTokens, manifest.priceSnapshot, options.mode === 'paid')
      records.push(record)
      await fs.appendFile(runLog, `${JSON.stringify(record)}\n`)
      if (options.mode === 'paid') {
        const reason = diagnosticStopReason(record, events)
        if (reason) { stopped = true; stopReason = reason }
        if (options.spentUsd && options.spentUsd() + reserve.probeUsd > options.maxUsd!) { stopped = true; stopReason = 'amount_cap_exceeded_after_provider_usage' }
      }
      console.log(JSON.stringify({ episode, status: record.observation.status, accepted: record.observation.accepted,
        diagnosticExecuted: record.diagnosticExecuted, diagnosticBeforeEdit: record.diagnosticBeforeEdit,
        diagnosticValueVisible: record.diagnosticValueVisible, diagnosticReported: record.diagnosticReported, reliable: record.reliable }))
      if (stopped) break
    }
    if (stopped) break
  }
  const report = diagnosticReport(manifest, records)
  await fs.writeFile(path.join(evidenceRoot, 'report.json'), `${JSON.stringify({ ...report, stopped, stopReason,
    spentUsdEstimate: options.mode === 'paid' ? (options.spentUsd?.() ?? 0) + reserve.probeUsd : null,
    maxUsd: options.maxUsd ?? null }, null, 2)}\n`, { flag: 'wx' })
  return { records, stopped, stopReason }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.length === 4 && args[0] === '--freeze-config' && args[2] === '--output') {
    const config = JSON.parse(await fs.readFile(args[1]!, 'utf8')) as DiagnosticConfig
    const manifest = await freezeDiagnostic(config, cleanHead())
    await fs.writeFile(args[3]!, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
    console.log(JSON.stringify({ output: args[3], digest: manifest.digest, episodes: manifest.episodes.length }))
    return
  }
  const validateOnly = args.length === 3 && args[0] === '--manifest' && args[2] === '--validate-only'
  const execute = args.length === 7 && args[0] === '--manifest' && args[2] === '--evidence-root' && args[4] === '--max-usd' && args[6] === '--execute'
  if (!validateOnly && !execute) throw new Error('usage: --freeze-config FILE --output NEW_MANIFEST; --manifest FILE --validate-only; or --manifest FILE --evidence-root NEW_DIRECTORY --max-usd AMOUNT --execute')
  const manifest = JSON.parse(await fs.readFile(args[1]!, 'utf8')) as DiagnosticManifest
  if (cleanHead() !== manifest.gitCommit) throw new Error('NX-51 frozen HEAD mismatch')
  await verifyDiagnosticManifest(manifest)
  const runtimeRoot = process.env.MINI_DSH_V2_RUNTIME
  if (!runtimeRoot) throw new Error('MINI_DSH_V2_RUNTIME is required')
  await preflightDiagnosticIsolation(runtimeRoot)
  if (validateOnly) {
    console.log(JSON.stringify({ manifestDigest: manifest.digest, episodes: manifest.episodes.length, isolation: 'passed', paidRequests: 0 }))
    return
  }
  const maxUsd = Number(args[5])
  if (!Number.isFinite(maxUsd) || maxUsd <= 0) throw new Error('--max-usd must be positive and finite')
  const reserve = diagnosticReserve(manifest.priceSnapshot)
  if (maxUsd < reserve.probeUsd + reserve.perEpisodeUsd * 2) throw new Error('amount cap cannot reserve probes and one complete block')
  if (await fs.stat(args[3]!).catch(() => undefined)) throw new Error('evidence root already exists')
  dotenv.config({ quiet: true })
  if (!process.env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY is required only for --execute')
  const modelId = manifest.model.slice('deepseek/'.length)
  const adapter = createDeepSeekAdapter({ baseUrl: manifest.baseUrl, models: [modelId], thinking: manifest.thinking, contextWindowTokens: manifest.window })
  const guard = createSmokeAmountGuard(adapter.chat, {
    source: manifest.priceSnapshot.source, capturedAt: manifest.priceSnapshot.capturedAt, currency: 'USD',
    peakInputPerMillion: manifest.priceSnapshot.inputPerMillion, peakOutputPerMillion: manifest.priceSnapshot.outputPerMillion,
    peakCacheReadPerMillion: manifest.priceSnapshot.cacheReadPerMillion,
  }, maxUsd - reserve.probeUsd)
  // Model/protocol probes belong to the same frozen batch and consume the reserved allowance.
  let probe: { model?: string; usage?: unknown }, streamed: Awaited<ReturnType<typeof adapter.chat>>
  try {
    const direct = await fetch(`${manifest.baseUrl}/chat/completions`, {
      method: 'POST', headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelId, max_tokens: 16, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: 'reply with the single word: ok' }] }),
      signal: AbortSignal.timeout(60_000),
    })
    if (!direct.ok) throw new Error(`model probe failed: HTTP ${direct.status}`)
    probe = await direct.json() as { model?: string; usage?: unknown }
    if (probe.model !== manifest.echoedModel || !probe.usage) throw new Error('NX-51 model probe echo or usage mismatch')
    streamed = await adapter.chat({ model: modelId, maxOutputTokens: 1024, messages: [{ role: 'user', content: 'reply with the single word: ok' }] })
    if (streamed.complete === false || streamed.usage?.source !== 'provider') throw new Error('NX-51 streaming probe usage missing')
  } catch (error) {
    const evidenceRoot = path.resolve(args[3]!)
    await fs.mkdir(evidenceRoot)
    await fs.writeFile(path.join(evidenceRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
    await fs.writeFile(path.join(evidenceRoot, 'probe-error.json'), `${JSON.stringify({ ...diagnoseV2Error(error instanceof Error ? error.message : String(error), []), reserveUsd: reserve.probeUsd })}\n`, { flag: 'wx' })
    await fs.writeFile(path.join(evidenceRoot, 'report.json'), `${JSON.stringify({ ...diagnosticReport(manifest, []), stopped: true, stopReason: 'protocol_probe_failed', spentUsdEstimate: reserve.probeUsd, maxUsd }, null, 2)}\n`, { flag: 'wx' })
    throw error
  }
  const result = await executeDiagnosticEpisodes({ manifest, evidenceRoot: path.resolve(args[3]!), runtimeRoot, mode: 'paid', maxUsd,
    spentUsd: () => guard.spentUsd, makeAdapter: () => ({ provider: 'deepseek', model: modelId, capabilities: adapter.capabilities, chat: guard.chat }) })
  await fs.writeFile(path.join(path.resolve(args[3]!), 'probe.json'), `${JSON.stringify({ echoedModel: probe.model, directUsage: probe.usage, streamedUsage: streamed.usage, reserveUsd: reserve.probeUsd }, null, 2)}\n`, { flag: 'wx' })
  if (result.stopped || result.records.length !== 12) process.exitCode = 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
