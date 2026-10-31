import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { HarnessAdapter } from '../src/app/create-harness.js'
import type { ChatRequest } from '../src/core/contracts.js'
import type { CommandOptions, CommandResult } from '../src/core/command-runner.js'
import { buildSchedule, validateRunManifest } from '../scripts/swebench/protocol.js'
import type { PriceSnapshot, SwebenchArm, SwebenchInstance, SwebenchRunManifest } from '../scripts/swebench/protocol.js'
import { runSwebenchBatch } from '../scripts/swebench/run.js'
import { exportPatch } from '../scripts/swebench/workspace.js'
import { createDockerCandidateRunner } from '../scripts/swebench/docker-candidate.js'
import { externalOverrideConfig } from '../scripts/swebench/external.js'
import { commandInterpreter, probeCommandEnvironment } from '../scripts/swebench/command-environment.js'
import { SWE_FULL_BUDGET, SWE_FULL_GUIDANCE } from '../scripts/swebench/harness-profile.js'

const prices: PriceSnapshot = { currency: 'USD', inputUsdPerMillion: 1, cachedInputUsdPerMillion: 0.5, outputUsdPerMillion: 2, capturedAt: '2026-10-31', source: 'test snapshot' }
const usage = { inputTokens: 1_000, outputTokens: 100, totalTokens: 1_100, source: 'provider' as const, uncertain: false, cacheReadTokens: 0 }
const model = { provider: 'scripted', name: 'agent', contextWindowTokens: 1_000_000 }
const arms: SwebenchArm[] = [
  { id: 'full', system: 'mini-dsh', harness: 'swe-full', role: 'full', model, budget: { inputTargetTokens: 65_536, ...SWE_FULL_BUDGET } },
  { id: 'minimal', system: 'mini-dsh', harness: 'v1', role: 'minimal', model, budget: { inputTargetTokens: 65_536 } },
]

function manifestFor(instances: SwebenchInstance[], overrides: Partial<SwebenchRunManifest> = {}): SwebenchRunManifest {
  const ids = arms.map(arm => arm.id)
  const caps = { maxCostUsd: 1, maxModelRequests: 10, maxToolCalls: 10, wallClockMs: 60_000, maxOutputTokens: 1_024 }
  return { schemaVersion: 3, kind: 'swebench-run-manifest', freezeStatus: 'frozen', protocol: 'swe-full-v1',
    dataset: { name: 'SWE-bench Verified', revision: 'test-revision' }, harnessCommit: 'abc1234', selection: {},
    development: { tasks: 1, seed: 1, exclusions: [], instances, arms: ids, schedule: buildSchedule(instances, ids, 1) },
    formal: { tasks: 1, seed: 2, exclusions: [], instances, arms: ids, schedule: buildSchedule(instances, ids, 2) },
    arms, promptTemplate: 'Issue:\n{problem_statement}\n', caps: { perTask: caps, developmentPerTask: caps, batch: { maxCostUsd: 10, maxEpisodes: 10 } },
    prices, scoring: {}, environment: { imageDigests: null, commandEnvironment: 'testbed-v1' }, authorization: 'test only', missing: [], createdAt: '2026-10-31', paidRequests: 0,
    ...overrides }
}

test('the swe-full arm assembles guidance, compact command results and frozen budget switches; minimal keeps v1', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-swe-full-'))
  try {
    const fixture = path.join(directory, 'fixtures', 'demo__fix-1')
    await fs.mkdir(fixture, { recursive: true })
    await fs.writeFile(path.join(fixture, 'input.txt'), 'broken\n')
    const instances: SwebenchInstance[] = [{ instance_id: 'demo__fix-1', repo: 'demo/fix', base_commit: 'a1', problem_statement: 'Rewrite input.txt so it contains exactly fixed.' }]
    const datasetPath = path.join(directory, 'dataset.json')
    await fs.writeFile(datasetPath, JSON.stringify(instances))
    const requests = new Map<string, ChatRequest[]>()
    const report = await runSwebenchBatch({ manifest: validateRunManifest(manifestFor(instances)), manifestPath: path.join(directory, 'm.json'), datasetPath,
      evidenceRoot: path.join(directory, 'evidence'), split: 'formal', backend: 'fixture', scoring: 'mock', batchId: 'swe-full-test', fixtureRoot: path.join(directory, 'fixtures'),
      adapterFor: arm => {
        const seen: ChatRequest[] = []
        requests.set(arm.id, seen)
        const adapter: HarnessAdapter = { provider: 'scripted', model: 'agent', capabilities: { agent: { contextWindowTokens: 1_000_000 } }, chat: async request => {
          seen.push(request)
          if (seen.length === 1) return { toolCalls: [{ id: randomUUID(), name: 'write_file', arguments: { path: 'input.txt', content: 'fixed\n' } }], usage }
          if (seen.length === 2) return { toolCalls: [{ id: randomUUID(), name: 'bash', arguments: { command: 'cat input.txt' } }], usage }
          return { content: 'done', usage }
        } }
        return adapter
      },
      scoreMock: async (_instance, workspace) => (await fs.readFile(path.join(workspace, 'input.txt'), 'utf8')).trim() === 'fixed' })
    assert.equal(report.perArm.find(arm => arm.armId === 'full')!.resolved, 1)
    assert.equal(report.perArm.find(arm => arm.armId === 'minimal')!.resolved, 1)
    const full = requests.get('full')!, minimal = requests.get('minimal')!
    assert.ok(String(full[0]!.system).includes(SWE_FULL_GUIDANCE.split('\n')[0]!))
    assert.ok(!String(minimal[0]!.system).includes(SWE_FULL_GUIDANCE.split('\n')[0]!))
    const bashResult = (request: ChatRequest) => String((request.messages ?? []).filter(message => message.role === 'tool').at(-1)!.content)
    assert.match(bashResult(full[2]!), /^exit 0 \(\d+\.\ds\)\n--- stdout ---\nfixed$/)
    assert.equal(JSON.parse(bashResult(minimal[2]!)).type, 'command', 'v1 keeps the JSON rendering')
    // 预算开关冻结进 run/start 的 policy，可从原始事件复算。
    const policyOf = async (arm: string) => {
      const sessionDir = path.join(directory, 'evidence', 'episodes', 'demo__fix-1', arm, 'session')
      const [session] = await fs.readdir(sessionDir)
      const events = (await fs.readFile(path.join(sessionDir, session!, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
      return events.find(event => event.type === 'run/start').data.state.policy
    }
    const fullPolicy = await policyOf('full'), minimalPolicy = await policyOf('minimal')
    assert.equal(fullPolicy.observationWindow, 6)
    assert.equal(fullPolicy.budgetNotices, true)
    assert.equal(fullPolicy.completionChecks, true)
    assert.equal(minimalPolicy.observationWindow, undefined)
    assert.equal(fullPolicy.maxTotalTokens, minimalPolicy.maxTotalTokens, 'both arms share the same token cap')
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('exported patches leave the harness result store out but keep real new files', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-export-'))
  try {
    const git = (...args: string[]) => spawnSync('git', args, { cwd: workspace, encoding: 'utf8' })
    git('init', '-q'); git('config', 'user.email', 't@example.invalid'); git('config', 'user.name', 't')
    await fs.writeFile(path.join(workspace, 'a.py'), 'x = 1\n'); git('add', '.'); git('commit', '-qm', 'base')
    const base = git('rev-parse', 'HEAD').stdout.trim()
    await fs.writeFile(path.join(workspace, 'a.py'), 'x = 2\n')
    await fs.writeFile(path.join(workspace, 'new_module.py'), 'y = 1\n')
    await fs.mkdir(path.join(workspace, '.mini-dsh', 'tool-results'), { recursive: true })
    await fs.writeFile(path.join(workspace, '.mini-dsh', 'tool-results', 'r.json'), '{}')
    const patch = exportPatch(workspace, base)
    assert.match(patch, /a\/a\.py/)
    assert.match(patch, /new_module\.py/)
    assert.doesNotMatch(patch, /\.mini-dsh/)
  } finally { await fs.rm(workspace, { recursive: true, force: true }) }
})

test('candidate docker runs and the external baseline share the testbed interpreter; legacy stays bash -lc', async () => {
  assert.deepEqual(commandInterpreter(), ['bash', '-lc'])
  assert.deepEqual(commandInterpreter('legacy'), ['bash', '-lc'])
  const testbed = commandInterpreter('testbed-v1')
  assert.match(testbed[2]!, /conda activate testbed && exec bash -c "\$1"/)
  assert.throws(() => commandInterpreter('base' as never), /commandEnvironment/)
  let captured: CommandOptions | undefined
  const fakeResult = { type: 'command', version: 1, command: '', cwd: '/testbed', status: 'exited', exitCode: 0, signal: null, durationMs: 1, timedOut: false, cancelled: false,
    stdout: { text: '', bytes: 0, truncated: false }, stderr: { text: '', bytes: 0, truncated: false } } as CommandResult
  const root = path.resolve(os.tmpdir(), 'cand')
  const runner = createDockerCandidateRunner(root, 'mini-dsh-run-x', { commandEnvironment: 'testbed-v1', run: async options => { captured = options; return fakeResult } })
  await runner({ executable: 'bash', args: [], command: 'python -c "print(1)"', cwd: root, signal: new AbortController().signal })
  assert.deepEqual(captured!.args, ['exec', '--workdir', '/testbed', 'mini-dsh-run-x', ...testbed, 'python -c "print(1)"'])
  const config = externalOverrideConfig({ model: 'deepseek/x', caps: { maxCostUsd: 1, maxModelRequests: 1, maxToolCalls: 1, wallClockMs: 1000, maxOutputTokens: 10, maxTotalTokens: 10 },
    paths: { episodeDirectory: '/e', workspace: '/w', datasetDirectory: '/d', configPath: '/c', outputDirectory: '/o', upstreamConfigPath: '/u' },
    uid: 1, gid: 1, labels: { batch: 'b', episode: 'e', instance: 'i' } as never, commandEnvironment: 'testbed-v1' }) as { environment: { interpreter: string[] } }
  assert.deepEqual(config.environment.interpreter, testbed)
})

test('the environment probe refuses unpinned images, a failing activation and the base interpreter', () => {
  assert.throws(() => probeCommandEnvironment('swebench/image:latest', 1, 1), /pinned image digest/)
  const image = `sha256:${'a'.repeat(64)}`
  assert.throws(() => probeCommandEnvironment(image, 1, 1, { run: () => ({ status: 1, stdout: '', stderr: 'conda: not found', error: undefined }) }), /preflight failed/)
  assert.throws(() => probeCommandEnvironment(image, 1, 1, { run: () => ({ status: 0, stdout: '{"python":"/opt/miniconda3/bin/python","prefix":"/opt/miniconda3"}\n', stderr: '', error: undefined }) }), /invalid testbed/)
  const ok = probeCommandEnvironment(image, 1, 1, { run: () => ({ status: 0, stdout: '{"python":"/opt/miniconda3/envs/testbed/bin/python","prefix":"/opt/miniconda3/envs/testbed"}\n', stderr: '', error: undefined }) })
  assert.equal(ok.commandEnvironment, 'testbed-v1')
})

test('manifest validation pins harness to mini-dsh arms and the command environment to known values', () => {
  const instances: SwebenchInstance[] = [{ instance_id: 'demo__fix-1', repo: 'demo/fix', base_commit: 'a1', problem_statement: 'p' }]
  const valid = validateRunManifest(manifestFor(instances))
  assert.equal(valid.protocol, 'swe-full-v1')
  assert.equal(valid.environment.commandEnvironment, 'testbed-v1')
  assert.equal(valid.arms[0]!.harness, 'swe-full')
  assert.equal(validateRunManifest(manifestFor(instances, { environment: { imageDigests: null } })).environment.commandEnvironment, undefined, 'historical manifests stay legacy')
  assert.throws(() => validateRunManifest(manifestFor(instances, { environment: { imageDigests: null, commandEnvironment: 'base' as never } })), /commandEnvironment/)
  assert.throws(() => validateRunManifest(manifestFor(instances, { arms: [{ ...arms[0]!, harness: 'v9' as never }, arms[1]!] })), /harness must be/)
  assert.throws(() => validateRunManifest(manifestFor(instances, { protocol: 'other' as never })), /protocol must be/)
})
