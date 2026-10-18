// Offline, read-only audit of existing NX-42 batches. Never opens a model adapter.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const source = process.argv[2]
if (!source) throw new Error('usage: node scripts/eval-history-audit.mjs <outputs-directory>')
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'))
const lines = file => fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse)
const batches = []
for (const name of fs.readdirSync(source).filter(name => name.startsWith('nx42-')).sort()) {
  const folder = path.join(source, name)
  const files = ['manifest.json', 'report.json', 'runs.jsonl'].map(file => path.join(folder, file))
  if (!files.every(fs.existsSync)) continue
  const [manifest, report, runs] = [read(files[0]), read(files[1]), lines(files[2])]
  batches.push({ batchId: name, protocol: manifest.protocol ?? null, codeSHA: manifest.gitCommit ?? null,
    manifestDigest: digest(files[0]), reportDigest: digest(files[1]), runsDigest: digest(files[2]),
    taskVersion: manifest.tasks ? crypto.createHash('sha256').update(JSON.stringify(manifest.tasks)).digest('hex') : null,
    split: manifest.split ?? null, tier: manifest.tier ?? null, model: manifest.model ?? null,
    thinking: manifest.thinking ?? null, sampling: manifest.sampling ?? null,
    arms: (manifest.arms ?? []).map(arm => ({ name: arm.name, budget: arm.budget, toolOutput: arm.toolOutput, promptLayout: arm.promptLayout })),
    planned: manifest.episodes?.length ?? report.planned ?? null, executed: runs.length,
    invalid: report.invalid ?? null, failureTypes: Object.fromEntries([...new Set(runs.map(run => run.failureReason).filter(Boolean))].sort().map(reason => [reason, runs.filter(run => run.failureReason === reason).length])),
    estimatedUsd: report.spentUsdEstimate ?? null, costBasis: report.spentUsdEstimate == null ? 'unknown' : 'report usage × manifest priceSnapshot; not provider invoice',
    priceSnapshot: manifest.priceSnapshot ?? null,
    unknownUsageEpisodes: runs.filter(run => run.metrics?.estimatedTokens > 0 || run.metrics?.providerTokens == null).length,
  })
}
const total = batches.reduce((sum, batch) => sum + (batch.estimatedUsd ?? 0), 0)
const result = { generatedAt: new Date().toISOString(), source, batches, foundBatches: batches.length,
  executed: batches.reduce((sum, batch) => sum + batch.executed, 0),
  knownEstimatedUsd: total, missingOrUnknownCost: batches.some(batch => batch.estimatedUsd == null || batch.unknownUsageEpisodes > 0) }
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
