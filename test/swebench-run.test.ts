import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { HarnessAdapter } from '../src/app/create-harness.js'
import { buildSchedule, validateRunManifest } from '../scripts/swebench/protocol.js'
import type { PriceSnapshot, SwebenchArm, SwebenchInstance, SwebenchRunManifest } from '../scripts/swebench/protocol.js'
import { runSwebenchBatch } from '../scripts/swebench/run.js'

const nowUsage = { inputTokens: 1_000, outputTokens: 500, totalTokens: 1_500, source: 'provider' as const, uncertain: false, cacheReadTokens: 0 }
const prices: PriceSnapshot = { currency: 'USD', inputUsdPerMillion: 1, cachedInputUsdPerMillion: 0.5, outputUsdPerMillion: 2, capturedAt: '2026-10-20', source: 'test snapshot' }

function scripted(options: { solve: boolean; usage?: boolean; throwOnFirst?: boolean }): { adapter: HarnessAdapter; calls: () => number } {
  let step = 0
  const adapter: HarnessAdapter = { provider: 'scripted', model: 'agent', capabilities: { agent: { contextWindowTokens: 1_000_000 } }, chat: async () => {
    step++
    if (options.throwOnFirst) throw new Error('simulated provider outage')
    const usage = options.usage === false ? undefined : nowUsage
    if (options.solve && step === 1) return { toolCalls: [{ id: randomUUID(), name: 'write_file', arguments: { path: 'input.txt', content: 'fixed\n' } }], usage }
    return { content: 'done', usage }
  } }
  return { adapter, calls: () => step }
}

async function fixtures(directory: string, ids: readonly string[]) {
  const root = path.join(directory, 'fixtures')
  const instances: SwebenchInstance[] = []
  for (const id of ids) {
    const dir = path.join(root, id)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'input.txt'), 'broken\n')
    instances.push({ instance_id: id, repo: 'demo/fix', base_commit: 'a1', problem_statement: 'Rewrite input.txt so it contains exactly fixed.' })
  }
  return { root, instances }
}

const arms: SwebenchArm[] = [
  { id: 'candidate', system: 'mini-dsh', role: 'candidate', model: { provider: 'scripted', name: 'agent', contextWindowTokens: 1_000_000 }, budget: { inputTargetTokens: 65_536 } },
  { id: 'baseline', system: 'external', role: 'baseline', model: { provider: 'scripted', name: 'agent', contextWindowTokens: 1_000_000 }, external: { commit: 'abc1234', command: ['baseline'] }, budget: {} },
]

function manifestFor(instances: SwebenchInstance[], overrides: Partial<SwebenchRunManifest> = {}): SwebenchRunManifest {
  const developmentInstances = instances.slice(0, 1)
  const armIds = arms.map(arm => arm.id)
  const base = {
    schemaVersion: 2 as const, kind: 'swebench-run-manifest' as const, freezeStatus: 'frozen' as const,
    dataset: { name: 'SWE-bench Verified', revision: 'test-revision' }, harnessCommit: 'abc1234', selection: {},
    development: { tasks: developmentInstances.length, seed: 1, exclusions: [], instances: developmentInstances, arms: armIds, schedule: buildSchedule(developmentInstances, armIds, 1) },
    formal: { tasks: instances.length, seed: 2, exclusions: [], instances, arms: armIds, schedule: buildSchedule(instances, armIds, 2) },
    arms, promptTemplate: 'Issue:\n{problem_statement}\n', caps: {
      perTask: { maxCostUsd: 1, maxModelRequests: 10, maxToolCalls: 10, wallClockMs: 60_000, maxOutputTokens: 1_024 },
      developmentPerTask: { maxCostUsd: 1, maxModelRequests: 10, maxToolCalls: 10, wallClockMs: 60_000, maxOutputTokens: 1_024 },
      batch: { maxCostUsd: 10, maxEpisodes: 20 },
    }, prices, scoring: {}, environment: { imageDigests: null }, authorization: 'test only', missing: [], createdAt: '2026-10-20', paidRequests: 0,
  }
  return { ...base, ...overrides }
}

async function writeDataset(directory: string, instances: readonly SwebenchInstance[]) {
  const file = path.join(directory, 'dataset.json')
  await fs.writeFile(file, JSON.stringify(instances, null, 2) + '\n')
  return file
}

test('the offline runner executes createHarness episodes, saves evidence, scores independently, and reports pairs', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-swebench-run-'))
  try {
    const { root, instances } = await fixtures(directory, ['demo__fix-1', 'demo__fix-2'])
    const datasetPath = await writeDataset(directory, instances)
    const manifest = validateRunManifest(manifestFor(instances))
    const adapters: string[] = []
    const report = await runSwebenchBatch({ manifest, manifestPath: path.join(directory, 'manifest-input.json'), datasetPath,
      evidenceRoot: path.join(directory, 'evidence'), split: 'formal', backend: 'fixture', scoring: 'mock', batchId: 'test-batch',
      fixtureRoot: root, adapterFor: (arm, instance) => {
        adapters.push(`${arm.id}/${instance.instance_id}`)
        const solved = arm.id === 'candidate' || instance.instance_id.endsWith('-1')
        return scripted({ solve: solved }).adapter
      },
      scoreMock: async (_instance, workspace) => (await fs.readFile(path.join(workspace, 'input.txt'), 'utf8')).trim() === 'fixed' })

    assert.equal(report.plannedEpisodes, 4)
    assert.equal(report.executedEpisodes, 4)
    assert.equal(report.unexecutedEpisodes, 0)
    assert.deepEqual(adapters.sort(), ['baseline/demo__fix-1', 'baseline/demo__fix-2', 'candidate/demo__fix-1', 'candidate/demo__fix-2'])
    const candidate = report.perArm.find(arm => arm.armId === 'candidate')!
    const baseline = report.perArm.find(arm => arm.armId === 'baseline')!
    assert.equal(candidate.resolved, 2)
    assert.equal(baseline.resolved, 1)
    assert.equal(baseline.statusCounts.completed, 2)
    assert.equal(report.scoring.empty, 1)
    const paired = report.paired.find(entry => entry.arms[0] === 'candidate')!
    assert.equal(paired.bothResolved, 1)
    assert.equal(paired.onlyA, 1)
    assert.equal(paired.onlyB, 0)
    assert.equal(paired.neither, 0)
    assert.equal(paired.mcnemarExactP, 1)
    const candidateEpisodes = report.evidence.filter(record => record.armId === 'candidate')
    for (const episode of candidateEpisodes) {
      assert.ok(episode.events)
      assert.equal(await fs.stat(path.join(directory, 'evidence', episode.events!)).then(stat => stat.isFile()), true)
      assert.match(await fs.readFile(path.join(directory, 'evidence', episode.patch!), 'utf8'), /input\.txt/)
    }
    const baselineEmpty = report.evidence.find(record => record.armId === 'baseline' && record.instanceId === 'demo__fix-2')!
    assert.equal(await fs.readFile(path.join(directory, 'evidence', baselineEmpty.patch!), 'utf8'), '')
    const runs = (await fs.readFile(path.join(directory, 'evidence', 'runs.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.equal(runs.length, 4)
    assert.equal(runs.filter((record: { resolved: boolean }) => record.resolved).length, 3)
    assert.ok(runs.every((record: { usageUnknown: boolean }) => record.usageUnknown === false))
    assert.ok(runs.every((record: { costUsd: number }) => record.costUsd > 0))
    assert.ok(await fs.stat(path.join(directory, 'evidence', 'SHA256SUMS')))
    assert.equal(report.batch.stopReason, undefined)
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('an infrastructure failure stops the batch and leaves unexecuted episodes explicit', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-swebench-stop-'))
  try {
    const { root, instances } = await fixtures(directory, ['demo__fix-1', 'demo__fix-2'])
    const datasetPath = await writeDataset(directory, instances)
    const manifest = validateRunManifest(manifestFor(instances))
    const report = await runSwebenchBatch({ manifest, manifestPath: path.join(directory, 'manifest-input.json'), datasetPath,
      evidenceRoot: path.join(directory, 'evidence'), split: 'formal', backend: 'fixture', scoring: 'mock', batchId: 'stop-batch',
      fixtureRoot: root, adapterFor: () => scripted({ solve: true, throwOnFirst: true }).adapter,
      scoreMock: async () => false })
    assert.equal(report.batch.stopReason, 'infrastructure_failure')
    assert.equal(report.executedEpisodes, 1)
    assert.equal(report.unexecutedEpisodes, report.plannedEpisodes - 1)
    assert.equal(report.perArm.reduce((total, arm) => total + arm.unexecuted, 0), report.plannedEpisodes - 1)
    assert.equal(report.failureTraces[0]?.kind, 'provider-or-infrastructure')
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('unknown provider usage is never zero-filled and stops a priced batch', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-swebench-usage-'))
  try {
    const { root, instances } = await fixtures(directory, ['demo__fix-1'])
    const datasetPath = await writeDataset(directory, instances)
    const manifest = validateRunManifest(manifestFor(instances))
    const report = await runSwebenchBatch({ manifest, manifestPath: path.join(directory, 'manifest-input.json'), datasetPath,
      evidenceRoot: path.join(directory, 'evidence'), split: 'formal', backend: 'fixture', scoring: 'mock', batchId: 'usage-batch',
      fixtureRoot: root, adapterFor: () => scripted({ solve: true, usage: false }).adapter,
      scoreMock: async () => false })
    assert.equal(report.batch.stopReason, 'usage_unknown')
    assert.equal(report.executedEpisodes, 1)
    assert.equal(report.batch.unknownCostEpisodes, 1)
    const arm = report.perArm.find(entry => entry.armId === report.evidence[0]!.armId)!
    assert.equal(arm.unknownCostEpisodes, 1)
    assert.equal(arm.knownCostUsd, 0)
    assert.equal(arm.usageMissingRatio, 1)
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('draft manifests and gold-bearing datasets are refused before any evidence is written', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-swebench-refuse-'))
  try {
    const { root, instances } = await fixtures(directory, ['demo__fix-1'])
    const datasetPath = await writeDataset(directory, instances)
    const draft = validateRunManifest(manifestFor(instances, { freezeStatus: 'draft' }))
    await assert.rejects(runSwebenchBatch({ manifest: draft, manifestPath: 'm', datasetPath, evidenceRoot: path.join(directory, 'draft-evidence'),
      split: 'formal', backend: 'fixture', scoring: 'mock', batchId: 'draft', fixtureRoot: root, adapterFor: () => scripted({ solve: true }).adapter,
      scoreMock: async () => true }), /draft manifest/)
    const goldPath = path.join(directory, 'gold.json')
    await fs.writeFile(goldPath, JSON.stringify([{ ...instances[0], patch: 'gold' }]))
    const frozen = validateRunManifest(manifestFor(instances))
    await assert.rejects(runSwebenchBatch({ manifest: frozen, manifestPath: 'm', datasetPath: goldPath, evidenceRoot: path.join(directory, 'gold-evidence'),
      split: 'formal', backend: 'fixture', scoring: 'mock', batchId: 'gold', fixtureRoot: root, adapterFor: () => scripted({ solve: true }).adapter,
      scoreMock: async () => true }), /gold\/hidden field patch/)
    assert.equal(await fs.stat(path.join(directory, 'draft-evidence')).catch(() => undefined), undefined)
    assert.equal(await fs.stat(path.join(directory, 'gold-evidence')).catch(() => undefined), undefined)
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('a stopped batch can resume without re-running completed or interrupted episodes', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-swebench-resume-'))
  try {
    const { root, instances } = await fixtures(directory, ['demo__fix-1', 'demo__fix-2'])
    const datasetPath = await writeDataset(directory, instances)
    const manifest = validateRunManifest(manifestFor(instances))
    const evidenceRoot = path.join(directory, 'evidence')
    const first = await runSwebenchBatch({ manifest, manifestPath: path.join(directory, 'manifest-input.json'), datasetPath,
      evidenceRoot, split: 'formal', backend: 'fixture', scoring: 'mock', batchId: 'resume-batch', fixtureRoot: root,
      adapterFor: () => scripted({ solve: true, throwOnFirst: true }).adapter, scoreMock: async () => false })
    assert.equal(first.batch.stopReason, 'infrastructure_failure')
    assert.equal(first.executedEpisodes, 1)
    let calls = 0
    const resumed = await runSwebenchBatch({ manifest, manifestPath: path.join(directory, 'manifest-input.json'), datasetPath,
      evidenceRoot, split: 'formal', backend: 'fixture', scoring: 'mock', batchId: 'resume-batch', fixtureRoot: root, resume: true,
      adapterFor: () => { calls++; return scripted({ solve: true }).adapter },
      scoreMock: async (_instance, workspace) => (await fs.readFile(path.join(workspace, 'input.txt'), 'utf8')).trim() === 'fixed' })
    assert.equal(calls, 3)
    assert.equal(resumed.executedEpisodes, 4)
    assert.equal(resumed.unexecutedEpisodes, 0)
    assert.equal(resumed.perArm.reduce((total, arm) => total + arm.statusCounts.infrastructure, 0), 1)
    assert.equal(resumed.batch.stopReason, undefined)
    assert.equal(resumed.scoring.resolved, 3)
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})
