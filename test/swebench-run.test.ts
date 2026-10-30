import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { HarnessAdapter } from '../src/app/create-harness.js'
import { buildSchedule, validateRunManifest } from '../scripts/swebench/protocol.js'
import type { EpisodeStatus, PriceSnapshot, SwebenchArm, SwebenchInstance, SwebenchRunManifest } from '../scripts/swebench/protocol.js'
import { runSwebenchBatch } from '../scripts/swebench/run.js'
import { componentArmDefinitions, COMPONENT_PROTOCOL } from '../scripts/swebench/component-protocol.js'
import { componentExposure, readComponentMetrics } from '../scripts/swebench/component-metrics.js'
import { buildReport } from '../scripts/swebench/report.js'
import type { ExternalEpisodeOutcome, ExternalEpisodeRequest } from '../scripts/swebench/external-run.js'

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

const externalCommand = ['{python}', '-m', 'minisweagent.run.benchmarks.swebench', '--subset', '{dataset}', '--split', 'test',
  '--output', '{output}', '--workers', '1', '--redo-existing', '-c', '{upstream_config}', '-c', '{config}']

const arms: SwebenchArm[] = [
  { id: 'candidate', system: 'mini-dsh', role: 'candidate', model: { provider: 'scripted', name: 'agent', contextWindowTokens: 1_000_000 }, budget: { inputTargetTokens: 65_536 } },
  { id: 'baseline', system: 'external', role: 'baseline', model: { provider: 'scripted', name: 'agent', contextWindowTokens: 1_000_000 }, external: {
    commit: 'a83fcae82d2a08f0ee0c688f9d137b3566c097f8', command: externalCommand, contractVersion: 1, version: '2.4.6',
    modelName: 'scripted/agent', upstreamConfigSha256: 'a'.repeat(64), installSha256: 'b'.repeat(64),
    environmentParity: 'candidate-isolation-v1', apiKeyEnv: 'DEEPSEEK_API_KEY',
  }, budget: {} },
]

const fixPatch = 'diff --git a/input.txt b/input.txt\n--- a/input.txt\n+++ b/input.txt\n@@ -1 +1 @@\n-broken\n+fixed\n'

function externalOutcome(input: { patch: string; status?: EpisodeStatus; usageUnknown?: boolean; costUsd?: number }): ExternalEpisodeOutcome {
  return { status: input.status ?? 'completed', patch: input.patch, costUsd: input.costUsd ?? 0.001, usageUnknown: input.usageUnknown ?? false,
    counters: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, modelRequests: 1, toolCalls: 1, activeDurationMs: 1 },
    external: { command: ['fake'], datasetPath: '', datasetSha256: 'c'.repeat(64), configPath: '', configSha256: 'd'.repeat(64),
      upstreamConfigPath: '', upstreamConfigSha256: 'e'.repeat(64), stdoutPath: '', stderrPath: '', resultPath: '',
      exitCode: 0, signal: null, durationMs: 1, maxTotalTokens: 1_000_000, miniExitStatus: 'Submitted', miniApiCalls: 1, miniReportedCostUsd: 0.001,
      actions: 1, usageReasons: [], containerIds: [], containerEnvNames: [], removedContainerIds: [], leftoverContainerIds: [], secretLeak: false } }
}

function manifestFor(instances: SwebenchInstance[], overrides: Partial<SwebenchRunManifest> = {}, armList: SwebenchArm[] = arms): SwebenchRunManifest {
  const developmentInstances = instances.slice(0, 1)
  const armIds = armList.map(arm => arm.id)
  const base = {
    schemaVersion: 3 as const, kind: 'swebench-run-manifest' as const, freezeStatus: 'frozen' as const,
    dataset: { name: 'SWE-bench Verified', revision: 'test-revision' }, harnessCommit: 'abc1234', selection: {},
    development: { tasks: developmentInstances.length, seed: 1, exclusions: [], instances: developmentInstances, arms: armIds, schedule: buildSchedule(developmentInstances, armIds, 1) },
    formal: { tasks: instances.length, seed: 2, exclusions: [], instances, arms: armIds, schedule: buildSchedule(instances, armIds, 2) },
    arms: armList, promptTemplate: 'Issue:\n{problem_statement}\n', caps: {
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
    const externalRequests: ExternalEpisodeRequest[] = []
    const report = await runSwebenchBatch({ manifest, manifestPath: path.join(directory, 'manifest-input.json'), datasetPath,
      evidenceRoot: path.join(directory, 'evidence'), split: 'formal', backend: 'fixture', scoring: 'mock', batchId: 'test-batch',
      fixtureRoot: root, adapterFor: (arm, instance) => {
        adapters.push(`${arm.id}/${instance.instance_id}`)
        return scripted({ solve: true }).adapter
      },
      externalRunner: async request => {
        externalRequests.push(request)
        return externalOutcome({ patch: request.instance.instance_id.endsWith('-1') ? fixPatch : '' })
      },
      scoreMock: async (_instance, workspace) => (await fs.readFile(path.join(workspace, 'input.txt'), 'utf8')).trim() === 'fixed' })

    assert.equal(report.plannedEpisodes, 4)
    assert.equal(report.executedEpisodes, 4)
    assert.equal(report.unexecutedEpisodes, 0)
    assert.deepEqual(adapters.sort(), ['candidate/demo__fix-1', 'candidate/demo__fix-2'])
    assert.ok(externalRequests.every(request => request.caps.maxTotalTokens === 500_000))
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

test('component arms expose real previews, recall, scoped rules and verification without claiming capability', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-swe-components-'))
  try {
    const { root, instances } = await fixtures(directory, ['demo__fix-1'])
    await fs.writeFile(path.join(root, 'demo__fix-1', 'AGENTS.md'), '# Rules\nPreserve the COMPONENT_RULE_SENTINEL.\n')
    await fs.writeFile(path.join(root, 'demo__fix-1', 'notes.txt'), ('payload ' + 'x'.repeat(1400) + '\n').repeat(30))
    const armList: SwebenchArm[] = componentArmDefinitions().map(definition => ({ ...definition,
      model: arms[0]!.model, ...(definition.system === 'external' ? { external: arms[1]!.external } : {}) }))
    const datasetPath = await writeDataset(directory, instances)
    // Exercise the execution knobs with a scripted adapter. Source identity of
    // the paid protocol is tested separately; these are zero-model fixtures.
    const manifest = validateRunManifest(manifestFor(instances, {}, armList))
    const report = await runSwebenchBatch({ manifest, manifestPath: '', datasetPath, evidenceRoot: path.join(directory, 'evidence'),
      split: 'formal', backend: 'fixture', scoring: 'mock', batchId: 'components', fixtureRoot: root,
      externalRunner: async () => externalOutcome({ patch: fixPatch }),
      adapterFor: arm => {
        let step = 0
        return { ...scripted({ solve: false }).adapter, chat: async request => {
          step++
          const call = (name: string, args: Record<string, unknown>) => ({ toolCalls: [{ id: randomUUID(), name, arguments: args }], usage: nowUsage })
          assert.equal(request.system?.includes('COMPONENT_RULE_SENTINEL'), arm.harness?.projectContext)
          if (step === 1) return call('read_file', { path: 'notes.txt' })
          if (step === 2 && arm.harness?.toolOutput) {
            const text = JSON.stringify(request.messages)
            const ref = text.match(/ref\\?"\s*:\s*\\?"([^"\\]+)/)?.[1]
            assert.ok(ref, 'a real preview must expose its stored result reference')
            return call('read_tool_result', { ref, offset: 100, maxBytes: 1024 })
          }
          const writeStep = arm.harness?.toolOutput ? 3 : 2
          if (step === writeStep) return call('write_file', { path: 'input.txt', content: 'fixed\n' })
          if (step === writeStep + 1) return call('bash', { command: 'cat input.txt', verification: { files: ['input.txt'] } })
          if (step === writeStep + 2) return call('task_report', {})
          return { content: 'done', usage: nowUsage }
        } }
      }, scoreMock: async (_instance, workspace) => (await fs.readFile(path.join(workspace, 'input.txt'), 'utf8')).trim() === 'fixed' })
    const full = report.perArm.find(arm => arm.armId === 'full')!
    const withoutOutput = report.perArm.find(arm => arm.armId === 'without-tool-output')!
    assert.equal(full.components?.toolOutput.triggeredEpisodes, 1)
    assert.equal(full.components?.successfulRecalls, 1)
    assert.equal(withoutOutput.components?.previewTruncations, 0)
    assert.equal(full.components?.projectContext.triggeredEpisodes, 1)
    assert.equal(report.perArm.find(arm => arm.armId === 'without-project-context')?.components?.projectContext.triggeredEpisodes, 0)
    assert.equal(full.components?.checks, 1)
    assert.equal(full.components?.reportReads, 1)
    assert.equal(full.components?.context.coverage, 'not-exercised')
    const rows = (await fs.readFile(path.join(directory, 'evidence', 'runs.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    const row = rows.find(record => record.armId === 'full')!
    assert.deepEqual(await readComponentMetrics(path.join(directory, 'evidence'), row), row.components)
    assert.equal(componentExposure([row.components, undefined], 'context').coverage, 'unknown')
    await assert.rejects(readComponentMetrics(directory, { sessionId: row.sessionId, eventsPath: '../outside.jsonl' }), /escapes/)
    assert.equal(report.perArm.every(arm => arm.resolvedOverPlanned === 1), true)
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('the same-source component contract rejects undeclared changes and incomplete comparisons keep the planned denominator', () => {
  const instance: SwebenchInstance = { instance_id: 'demo__fix-1', repo: 'demo/fix', base_commit: 'a1', problem_statement: 'Fix' }
  const armList: SwebenchArm[] = componentArmDefinitions().map(definition => ({ ...definition, model: arms[0]!.model,
    ...(definition.system === 'external' ? { external: arms[1]!.external } : {}) }))
  const manifest = manifestFor([instance], { selection: { protocol: COMPONENT_PROTOCOL, sourceCommit: 'a'.repeat(40) },
    environment: { imageDigests: null, commandEnvironment: 'testbed-v1' } }, armList)
  assert.equal(validateRunManifest(manifest).arms.length, 6)
  const mutated = structuredClone(manifest)
  mutated.arms[2]!.budget.inputTargetTokens = 32_768
  assert.throws(() => validateRunManifest(mutated), /budget drift/)
  mutated.arms[2]!.budget.inputTargetTokens = 65_536
  mutated.arms[2]!.harness!.toolOutput = false
  assert.throws(() => validateRunManifest(mutated), /harness drift/)
  assert.throws(() => validateRunManifest({ ...manifest, environment: { imageDigests: null } }), /testbed-v1/)
  const records = [{ instanceId: instance.instance_id, armId: 'full', status: 'completed' as const, resolved: true, emptyPatch: false, patchPath: 'x' }]
  const scores = { runIds: {}, results: [{ instanceId: instance.instance_id, armId: 'full', resolved: true, classification: 'resolved' as const, scoreRunId: 's' }] }
  const report = buildReport(manifest, 'formal', records, scores, { stopReason: 'incomplete', startedAt: '', finishedAt: '' })
  const pair = report.paired.find(pair => pair.arms[1] === 'harness-baseline')!
  assert.equal(pair.total, 1)
  assert.equal(pair.complete, false)
  assert.equal(report.componentComparisons?.[0]?.interpretation, 'incomplete-evidence')
  assert.throws(() => buildReport(manifest, 'formal', records, { ...scores, results: [...scores.results, ...scores.results] }, { startedAt: '', finishedAt: '' }), /duplicate/)
})

test('development-only freezes reject formal execution and validate-only cannot create evidence or call adapters', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-swe-preflight-'))
  try {
    const { root, instances } = await fixtures(directory, ['demo__fix-1'])
    const datasetPath = await writeDataset(directory, instances)
    const manifest = validateRunManifest(manifestFor(instances, { executionScope: 'development' }, [arms[0]!]))
    let calls = 0
    const options = { manifest, manifestPath: '', datasetPath, evidenceRoot: path.join(directory, 'evidence'),
      split: 'development' as const, backend: 'fixture' as const, scoring: 'mock' as const, batchId: 'validate-only', fixtureRoot: root,
      adapterFor: () => { calls++; return scripted({ solve: true }).adapter }, scoreMock: () => { calls++; return true } }
    const report = await runSwebenchBatch({ ...options, validateOnly: true })
    assert.equal('validationOnly' in report && report.validationOnly, true)
    assert.equal(report.executedEpisodes, 0)
    assert.equal(calls, 0)
    assert.equal(await fs.stat(options.evidenceRoot).then(() => true, () => false), false)
    await assert.rejects(runSwebenchBatch({ ...options, split: 'formal' }), /development only/)
    assert.equal(calls, 0)
    assert.throws(() => validateRunManifest({ ...manifest, executionScope: 'unexpected' }), /executionScope/)
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('an infrastructure failure stops the batch and leaves unexecuted episodes explicit', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-swebench-stop-'))
  try {
    const { root, instances } = await fixtures(directory, ['demo__fix-1', 'demo__fix-2'])
    const datasetPath = await writeDataset(directory, instances)
    const manifest = validateRunManifest(manifestFor(instances, {}, [arms[0]!]))
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
    const manifest = validateRunManifest(manifestFor(instances, {}, [arms[0]!]))
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

test('official scoring refuses to start without complete hidden rows and never creates evidence', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-swebench-scoring-'))
  try {
    const { root, instances } = await fixtures(directory, ['demo__fix-1'])
    const datasetPath = await writeDataset(directory, instances)
    const frozen = validateRunManifest(manifestFor(instances, {}, [arms[0]!]))
    const missing = path.join(directory, 'missing-evidence')
    await assert.rejects(runSwebenchBatch({ manifest: frozen, manifestPath: 'm', datasetPath, evidenceRoot: missing,
      split: 'formal', backend: 'fixture', scoring: 'official', batchId: 'official-missing', fixtureRoot: root,
      adapterFor: () => scripted({ solve: true }).adapter }), /--scoring-dataset/)
    assert.equal(await fs.stat(missing).catch(() => undefined), undefined)

    const incompleteRows = path.join(directory, 'incomplete-rows.json')
    await fs.writeFile(incompleteRows, JSON.stringify([{ instance_id: 'demo__fix-1', repo: 'demo/fix', base_commit: 'a1' }]))
    const incomplete = path.join(directory, 'incomplete-evidence')
    await assert.rejects(runSwebenchBatch({ manifest: frozen, manifestPath: 'm', datasetPath, evidenceRoot: incomplete,
      split: 'formal', backend: 'fixture', scoring: 'official', scoringDataset: incompleteRows, batchId: 'official-incomplete',
      fixtureRoot: root, adapterFor: () => scripted({ solve: true }).adapter }), /lacks test_patch/)
    assert.equal(await fs.stat(incomplete).catch(() => undefined), undefined)
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('a stopped batch can resume without re-running completed or interrupted episodes', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-swebench-resume-'))
  try {
    const { root, instances } = await fixtures(directory, ['demo__fix-1', 'demo__fix-2'])
    const datasetPath = await writeDataset(directory, instances)
    const manifest = validateRunManifest(manifestFor(instances, {}, [arms[0]!]))
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
    assert.equal(calls, 1)
    assert.equal(resumed.executedEpisodes, 2)
    assert.equal(resumed.unexecutedEpisodes, 0)
    assert.equal(resumed.perArm.reduce((total, arm) => total + arm.statusCounts.infrastructure, 0), 1)
    assert.equal(resumed.batch.stopReason, undefined)
    assert.equal(resumed.scoring.resolved, 1)
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})
