import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import dotenv from 'dotenv'
import { createDeepSeekAdapter } from '../src/models/deepseek.js'
import { assertCleanCode, verifySmokeManifest, type SmokeManifest } from './smoke-manifest.js'
import { selectSmokeScenarios } from './smoke-plan.js'
import { runSmokeScenario } from './smoke-scenarios.js'
import { createIsolationBackend } from './eval-v2-isolation.js'
import { createSmokeAmountGuard, smokeReserveUsd } from './smoke-cost.js'

const args = process.argv.slice(2)
const validateOnly = args.length === 5 && args[0] === '--manifest' && args[2] === '--scenarios' && args[4] === '--validate-only'
const execute = args.length === 9 && args[0] === '--manifest' && args[2] === '--scenarios' && args[4] === '--evidence-root' && args[6] === '--max-usd' && args[8] === '--execute'
if (!validateOnly && !execute) throw new Error('usage: smoke-run --manifest FILE --scenarios repair --validate-only; or --manifest FILE --scenarios repair --evidence-root NEW_DIRECTORY --max-usd AMOUNT --execute')
const selected = selectSmokeScenarios(args[3]!)
const manifest = JSON.parse(await fs.readFile(path.resolve(args[1]!), 'utf8')) as SmokeManifest
assertCleanCode()
await verifySmokeManifest(manifest, args[3]!)
if (![manifest.price.peakInputPerMillion, manifest.price.peakOutputPerMillion, manifest.price.peakCacheReadPerMillion].every(value => Number.isFinite(value) && value >= 0) || manifest.price.peakInputPerMillion <= 0 || manifest.price.peakOutputPerMillion <= 0 || manifest.price.currency !== 'USD') throw new Error('invalid smoke price snapshot')
const maxRequests = selected.reduce((sum, item) => sum + item.maxMainRequests + item.maxSummaryRequests, 0)
const maxTotalTokens = selected.reduce((sum, item) => sum + item.maxTotalTokens, 0)
const reserve = smokeReserveUsd(selected, manifest.price)
const reserveUsd = reserve.reserveUsd
if (validateOnly) {
  console.log(JSON.stringify({ protocol: manifest.protocol, manifestDigest: manifest.digest, codeSHA: manifest.codeSHA, scenarios: selected.map(item => item.id), maxRequests, maxTotalTokens, reserve, paidRequests: 0 }))
  process.exit(0)
}
const maxUsd = Number(args[7])
if (!Number.isFinite(maxUsd) || maxUsd < reserveUsd) throw new Error(`--max-usd must reserve selected scenarios: at least $${reserveUsd.toFixed(4)}`)
const evidenceRoot = path.resolve(args[5]!)
if (await fs.stat(evidenceRoot).catch(() => undefined)) throw new Error('smoke evidence root must not exist')
const runtimeRoot = process.env.MINI_DSH_V2_RUNTIME
if (!runtimeRoot || !(await fs.stat(runtimeRoot).catch(() => undefined))?.isDirectory()) throw new Error('MINI_DSH_V2_RUNTIME must point to the pinned isolated Linux runtime')
const preflight = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-smoke-preflight-'))
try {
  const sentinel = path.join(path.dirname(preflight), `${path.basename(preflight)}-hidden.txt`)
  await fs.writeFile(sentinel, 'host-only', { flag: 'wx' })
  try {
    const backend = createIsolationBackend({ workspace: preflight, runtimeRoot })
    const capabilities = await backend.preflight()
    const result = await backend.run({
      executable: 'ignored', args: [], command: `node --version && test ! -r '${backend.visibleHostPath(sentinel)}'`, cwd: preflight,
      signal: new AbortController().signal, timeoutMs: 10_000,
    })
    if (result.status !== 'exited' || result.exitCode !== 0 || !result.stdout.text.includes('v22.22.1')) throw new Error(`smoke Linux isolation preflight failed (${capabilities.kind})`)
  } finally { await fs.rm(sentinel, { force: true }) }
} finally { await fs.rm(preflight, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }) }
dotenv.config({ quiet: true })
if (!process.env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY required for authorized smoke')
const adapter = createDeepSeekAdapter({ apiKey: process.env.DEEPSEEK_API_KEY, baseUrl: manifest.wire.baseUrl, models: [manifest.model], thinking: manifest.wire.thinking, contextWindowTokens: 1_000_000 })
const amount = createSmokeAmountGuard(adapter.chat, manifest.price, maxUsd)
await fs.mkdir(evidenceRoot)
await fs.writeFile(path.join(evidenceRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
const env = { manifest, evidenceRoot, runtimeRoot, adapter: { ...adapter, chat: amount.chat } }
const results: unknown[] = []
for (const scenario of selected) {
  try {
    const result = await runSmokeScenario(env, scenario)
    results.push({ scenario: scenario.id, ...result })
    await fs.writeFile(path.join(evidenceRoot, scenario.id, 'result.json'), `${JSON.stringify(results.at(-1), null, 2)}\n`, { flag: 'wx' })
    if (result.status !== 'passed') break
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    results.push({ scenario: scenario.id, status: 'error', errorType: error instanceof Error ? error.name : 'unknown', httpStatus: /^DeepSeek API (\d{3}):/.exec(message)?.[1] ?? null })
    break
  }
}
await fs.writeFile(path.join(evidenceRoot, 'smoke-report.json'), `${JSON.stringify({ protocol: manifest.protocol, manifestDigest: manifest.digest, codeSHA: manifest.codeSHA, selectedScenarios: selected.map(item => item.id), maxUsd, reserve, chargedUsdPeakEstimate: amount.spentUsd, usageUnknown: amount.usageUnknown, dispatchedRequests: amount.calls, formalEffectStatistic: false, results }, null, 2)}\n`, { flag: 'wx' })
console.log(JSON.stringify({ evidenceRoot, scenariosAttempted: results.length, allPassed: results.length === selected.length && results.every(item => (item as { status: string }).status === 'passed'), formalEffectStatistic: false }))
if (results.length !== selected.length || results.some(item => (item as { status: string }).status !== 'passed')) process.exitCode = 1
