import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createFixture } from './coding-fixtures.js'
import { runFixtureTask, scriptedAdapter } from './eval-fixture.js'
import { evalPolicy } from './eval-runner.js'
import { ProviderError } from '../src/core/model-error.js'
import type { SessionEvent } from '../src/core/contracts.js'

// R09：两条**专门生成**的合成轨迹。它们验证事件格式、失败恢复与成本复算，不是模型能力证据。
// 生成过程不调用真实 provider；适配器是脚本化的，usage 由适配器显式给出 provider 形态。
const priceSnapshot = {
  currency: 'USD',
  unit: 'per_million_tokens',
  input: 0.28,
  cacheRead: 0.028,
  output: 0.42,
  source: 'synthetic example; not a provider bill',
}
const targetDefault = 'docs/samples'

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const sanitize = (value: string) => {
  let result = value
  for (const [root, label] of [[os.tmpdir(), '<tmp>'], [os.homedir(), '<home>']] as const) {
    for (const variant of [root, root.replaceAll('\\', '\\\\'), root.replaceAll('\\', '/')]) result = result.replaceAll(variant, label)
  }
  return result
    .replace(/mini-dsh-fixture-[A-Za-z0-9-]+/g, 'fixture')
    .replace(/mini-dsh-evidence-[A-Za-z0-9-]+/g, 'evidence')
}

function sanitizeEvent(event: SessionEvent): SessionEvent {
  const visit = (value: unknown): unknown => {
    if (typeof value === 'string') return sanitize(value)
    if (Array.isArray(value)) return value.map(visit)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, visit(entry)]))
    return value
  }
  return visit(event) as SessionEvent
}

function filePatch(file: string, oldText: string, newText: string) {
  const oldLines = oldText.split('\n'), newLines = newText.split('\n')
  return `--- a/${file}\n+++ b/${file}\n@@ -1,${oldLines.length} +1,${newLines.length} @@\n${oldLines.map(line => `-${line}`).join('\n')}\n${newLines.map(line => `+${line}`).join('\n')}\n`
}

export function summarize(events: readonly SessionEvent[]) {
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheReadMissing: 0 }
  const starts = new Map<string, boolean>()
  const settled = new Set<string>()
  const rejected = new Set<string>()
  let estimatedUsage = 0, retries = 0, summaries = 0, toolCalls = 0, toolErrors = 0, skippedTools = 0, errors = 0
  let runStatus = 'unknown'
  for (const event of events) {
    if (event.type === 'model/start') starts.set(event.data.requestId, event.data.estimatedInputTokens !== undefined)
    if (event.type === 'model/rejected') { rejected.add(event.data.requestId); settled.add(event.data.requestId) }
    if (event.type === 'model/retry') retries++
    if (event.type === 'context/summary-start') summaries++
    if (event.type === 'run/error') errors++
    if (event.type === 'model/usage') {
      if (settled.has(event.data.requestId)) continue
      settled.add(event.data.requestId)
      if (event.data.usage.source !== 'provider') { estimatedUsage++; continue }
      usage.inputTokens += event.data.usage.inputTokens
      usage.outputTokens += event.data.usage.outputTokens
      if (event.data.usage.cacheReadTokens === undefined) usage.cacheReadMissing++
      else usage.cacheReadTokens += event.data.usage.cacheReadTokens
    }
    if (event.type === 'tool/result') {
      if (event.data.status === 'skipped') skippedTools++
      else toolCalls++
      if (event.data.isError && event.data.status !== 'skipped') toolErrors++
    }
    if (event.type === 'run/finish') runStatus = event.data.state.status
  }
  let missingUsage = 0
  for (const requestId of starts.keys()) if (!settled.has(requestId) && !rejected.has(requestId)) missingUsage++
  const cache = usage.cacheReadTokens
  const costUsd = ((usage.inputTokens - cache) * priceSnapshot.input + cache * priceSnapshot.cacheRead + usage.outputTokens * priceSnapshot.output) / 1_000_000
  return {
    status: runStatus,
    requests: { dispatched: starts.size, retries, rejected: rejected.size, summaries, missingUsage, estimatedUsage },
    usage,
    costUsd: Number(costUsd.toFixed(9)),
    missingUsage,
    tools: { calls: toolCalls, errors: toolErrors, skipped: skippedTools },
    errors,
    costBasis: estimatedUsage ? `provider usage only; ${estimatedUsage} estimated attempt(s) excluded` : 'provider usage',
  }
}

async function sessionDirectory(root: string) {
  const entries = await fs.readdir(root, { withFileTypes: true })
  const session = entries.find(entry => entry.isDirectory())
  if (!session) throw new Error(`no session directory under ${root}`)
  return path.join(root, session.name)
}

async function buildScenario(name: 'normal-fix' | 'provider-recovery', root: string) {
  const fixture = await createFixture('repair')
  const patch = fixture.edits.map(edit => filePatch(edit.path, edit.oldText, edit.newText)).join('')
  await fixture.close()
  const sessionRoot = path.join(root, 'raw', name)
  const outcome = await runFixtureTask('repair', input => {
    const base = scriptedAdapter(input)
    let failed = false
    return {
      ...base,
      chat: async request => {
        if (name === 'provider-recovery' && !failed) { failed = true; throw new ProviderError('rate_limit', 429, true, undefined, 1) }
        const response = await base.chat(request)
        // 合成 provider usage：只为让成本可复算，不代表这些请求的真实计费。
        return { ...response, usage: { inputTokens: 900, outputTokens: 40, totalTokens: 940, source: 'provider', uncertain: false, cacheReadTokens: 100 } }
      },
    }
  }, evalPolicy, sessionRoot)
  const session = await sessionDirectory(sessionRoot)
  const events = (await fs.readFile(path.join(session, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => sanitizeEvent(JSON.parse(line) as SessionEvent))
  const report = summarize(events)
  return { name, outcome, sessionDir: session, events, patch, report }
}

async function writeEpisode(target: string, scenario: Awaited<ReturnType<typeof buildScenario>>, source: { commit: string; dirty: boolean }) {
  const directory = path.join(target, scenario.name)
  await fs.mkdir(directory, { recursive: true })
  const eventsText = scenario.events.map(event => JSON.stringify(event)).join('\n') + '\n'
  await fs.writeFile(path.join(directory, 'events.jsonl'), eventsText)
  await fs.writeFile(path.join(directory, 'patch.diff'), scenario.patch)
  const acceptance = scenario.outcome.acceptance
  const verification = {
    accepted: scenario.outcome.accepted,
    exitCode: acceptance?.exitCode ?? null,
    protectedFilesChanged: acceptance?.protectedFilesChanged ?? [],
    output: sanitize(acceptance?.output ?? '').slice(0, 4096),
  }
  await fs.writeFile(path.join(directory, 'verification.json'), JSON.stringify(verification, null, 2) + '\n')
  const firstStart = scenario.events.find(event => event.type === 'model/start')
  const manifest = {
    schemaVersion: 1,
    kind: 'synthetic',
    episode: scenario.name,
    sourceCommit: source.commit,
    dirty: source.dirty,
    model: { provider: 'scripted', model: 'fixture', observed: null },
    budget: evalPolicy,
    taskSet: ['repair'],
    orderSeed: 0,
    toolSchemaSha256: firstStart?.type === 'model/start' ? firstStart.data.schemaDigest ?? null : null,
    policyVersion: sha256(JSON.stringify(evalPolicy)),
    environment: { node: process.version, platform: process.platform },
    priceSnapshot,
    missing: { usage: scenario.report.missingUsage, cacheRead: scenario.report.usage.cacheReadMissing },
  }
  await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(scenario.report, null, 2) + '\n')
  const files = ['manifest.json', 'events.jsonl', 'patch.diff', 'verification.json', 'report.json']
  const sums = await Promise.all(files.map(async file => `${sha256(await fs.readFile(path.join(directory, file)))}  ${file}`))
  await fs.writeFile(path.join(directory, 'SHA256SUMS'), sums.join('\n') + '\n')
  return scenario.report
}

export function formatResults(reports: readonly { name: string; report: ReturnType<typeof summarize> }[], verification: readonly { name: string; accepted: boolean }[]) {
  const rows = reports.map(({ name, report }) => {
    const accepted = verification.find(item => item.name === name)?.accepted ?? false
    return `| ${name} | ${report.status} | ${accepted ? 'yes' : 'no'} | ${report.requests.dispatched} | ${report.requests.retries} | ${report.tools.calls} | ${report.tools.errors} | ${report.usage.inputTokens} | ${report.usage.cacheReadTokens} | ${report.usage.outputTokens} | ${report.costUsd.toFixed(9)} | ${report.missingUsage} |`
  })
  return [
    '# Synthetic evidence results',
    '',
    'These two episodes are **scripted/offline mechanism evidence**, not model capability results. They verify event format, provider-failure recovery, acceptance, and offline cost recomputation. They must not be reported as a benchmark score.',
    '',
    'Cost uses the synthetic price snapshot in each manifest: `(input - cacheRead) × input + cacheRead × cacheReadPrice + output × outputPrice`, normalized per million tokens. It is an estimate for the sample, not a provider bill.',
    '',
    '| Episode | Status | Accepted | Requests | Retries | Tool calls | Tool errors | Input | Cache read | Output | Cost (USD) | Missing usage |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...rows,
    '',
    'Reproduce offline: `pnpm build && node dist/scripts/recompute-report.js docs/samples --check`. The command verifies every `SHA256SUMS`, replays reports from `events.jsonl`, and compares this file.',
    '',
  ].join('\n')
}

async function main() {
  const target = path.resolve(process.argv[2] ?? targetDefault)
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-evidence-'))
  try {
    const normal = await buildScenario('normal-fix', work)
    const recovery = await buildScenario('provider-recovery', work)
    if (!normal.outcome.accepted || !recovery.outcome.accepted) throw new Error('synthetic scenarios must pass acceptance')
    if (recovery.report.requests.retries < 1) throw new Error('provider-recovery scenario did not record a retry')
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    const dirty = execFileSync('git', ['status', '--porcelain', '--', ':!docs/samples'], { encoding: 'utf8' }).trim().length > 0
    await fs.rm(target, { recursive: true, force: true })
    await fs.mkdir(target, { recursive: true })
    const normalReport = await writeEpisode(target, normal, { commit, dirty })
    const recoveryReport = await writeEpisode(target, recovery, { commit, dirty })
    const results = formatResults(
      [{ name: 'normal-fix', report: normalReport }, { name: 'provider-recovery', report: recoveryReport }],
      [{ name: 'normal-fix', accepted: normal.outcome.accepted }, { name: 'provider-recovery', accepted: recovery.outcome.accepted }],
    )
    await fs.writeFile(path.resolve('docs/RESULTS.md'), results)
    console.log(`wrote ${target} and docs/RESULTS.md (source ${commit}, dirty=${dirty})`)
  } finally { await fs.rm(work, { recursive: true, force: true }) }
}

if (process.argv[1] && /export-public-evidence\.js$/.test(process.argv[1])) {
  main().catch(error => { console.error(error instanceof Error ? error.stack : error); process.exitCode = 1 })
}
