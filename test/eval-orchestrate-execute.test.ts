import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { HarnessAdapter } from '../src/app/create-harness.js'
import { runCommand } from '../src/core/command-runner.js'
import type { ChatRequest } from '../src/core/contracts.js'
import { rehearsalAdapter, rehearsalTasks } from '../scripts/eval-orchestrate-arms.js'
import { batchEchoedModel, batchModel, freezeBatchManifest, writeBatchManifest } from '../scripts/eval-orchestrate-batch.js'
import { executeBatch, type ExecuteDeps } from '../scripts/eval-orchestrate-run.js'
import { assembleRunMatrix, parseEvalArgs } from '../scripts/eval-orchestrate.js'
import { orchestrationFixtureIds } from '../scripts/orchestration-fixtures.js'

const probeText = 'reply with the single word: ok'
const usage = { inputTokens: 10, outputTokens: 1, totalTokens: 11, source: 'provider' as const, uncertain: false, cacheReadTokens: 0 }

async function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-exec-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const repository = path.join(root, 'checkout')
  await fs.mkdir(repository)
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: repository, encoding: 'utf8' })
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`)
    return result.stdout.trim()
  }
  git('init', '-q')
  await fs.writeFile(path.join(repository, 'package.json'), '{}\n')
  git('add', '-A')
  git('-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '-m', 'base')
  const head = git('rev-parse', 'HEAD')
  const manifestPath = path.join(root, 'manifest.json')
  const manifest = freezeBatchManifest({ specs: assembleRunMatrix({ model: batchModel }), gitCommit: head, createdAt: '2026-11-08T00:00:00.000Z' })
  await writeBatchManifest(manifestPath, manifest)
  const calls = { probe: 0, chat: 0, preflight: 0 }
  const tasks = await rehearsalTasks(orchestrationFixtureIds, path.join(root, 'scratch'))
  const scripted = rehearsalAdapter(tasks)
  // 探测请求回 provider usage；之后的 run 请求去掉 usage，用来触发“未知用量即停批”。
  const adapter: HarnessAdapter = {
    provider: 'deepseek', model: 'deepseek-flash', capabilities: { 'deepseek-flash': { contextWindowTokens: 1_000_000 } },
    chat: async (request: ChatRequest) => {
      calls.chat++
      const first = request.messages?.[0]
      if (typeof first?.content === 'string' && first.content === probeText) return { usage, content: 'ok', complete: true, observedModel: batchEchoedModel }
      const response = await scripted.chat(request)
      return { ...response, usage: undefined }
    },
  }
  const deps = (overrides: Partial<ExecuteDeps> = {}): ExecuteDeps => ({
    env: { DEEPSEEK_API_KEY: 'test-key', MINI_DSH_V2_RUNTIME: root }, repository,
    createAdapter: () => adapter,
    directProbe: async () => { calls.probe++; return { model: batchEchoedModel, usage: { prompt_tokens: 10 }, finishReason: 'stop' } },
    preflight: async () => { calls.preflight++; return 'test-host' },
    runnerFactory: () => () => options => runCommand(options),
    ...overrides,
  })
  return { root, repository, git, manifest, manifestPath, deps, calls, evidence: path.join(root, 'evidence') }
}
const exists = (target: string) => fs.stat(target).then(() => true, () => false)

test('every execute gate refuses before an evidence root exists or any request is made', async t => {
  const { manifest, manifestPath, deps, calls, evidence, repository, git, root } = await setup(t)
  const max = manifest.reserve.batchUsd
  const refuse = async (options: { manifestPath?: string; maxUsd?: number; evidenceRoot?: string }, depsOverride: Partial<ExecuteDeps>, pattern: RegExp) => {
    await assert.rejects(executeBatch({ manifestPath, evidenceRoot: evidence, maxUsd: max, ...options }, deps(depsOverride)), pattern)
    assert.equal(await exists(evidence), false, `evidence root created for ${pattern}`)
  }
  await refuse({ maxUsd: manifest.reserve.probeUsd }, {}, /cover the probe and one run/)
  await refuse({ maxUsd: max + 1 }, {}, /exceeds the frozen batch ceiling/)
  await refuse({}, { env: { MINI_DSH_V2_RUNTIME: root } }, /DEEPSEEK_API_KEY is required/)
  await refuse({}, { env: { DEEPSEEK_API_KEY: 'k' } }, /MINI_DSH_V2_RUNTIME is required/)
  const tampered = path.join(root, 'tampered.json')
  await fs.writeFile(tampered, JSON.stringify({ ...manifest, matrixDigest: '0'.repeat(64) }))
  await refuse({ manifestPath: tampered }, {}, /matrix digest does not match/)
  const cheaper = path.join(root, 'cheaper.json')
  await fs.writeFile(cheaper, JSON.stringify({ ...manifest, reserve: { ...manifest.reserve, batchUsd: 1 } }))
  await refuse({ manifestPath: cheaper }, {}, /cost ceiling does not match/)
  await fs.writeFile(path.join(repository, 'dirty.txt'), 'x')
  await refuse({}, {}, /dirty working tree/)
  await fs.rm(path.join(repository, 'dirty.txt'))
  git('-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '--allow-empty', '-m', 'moved')
  await refuse({}, {}, /is not the frozen commit/)
  git('reset', '-q', '--hard', 'HEAD~1')
  await fs.mkdir(evidence)
  await assert.rejects(executeBatch({ manifestPath, evidenceRoot: evidence, maxUsd: max }, deps()), /already exists/)
  assert.deepEqual(await fs.readdir(evidence), [])
  assert.equal(calls.probe, 0)
  assert.equal(calls.chat, 0)
})

test('a protocol probe mismatch stops the batch before any run', async t => {
  const { manifest, manifestPath, deps, calls, evidence } = await setup(t)
  const result = await executeBatch(
    { manifestPath, evidenceRoot: evidence, maxUsd: manifest.reserve.batchUsd },
    deps({ directProbe: async () => ({ model: 'deepseek-v4-pro', usage: {} }) }),
  )
  assert.equal(result.stopReason, 'protocol_probe_failed')
  assert.equal(calls.chat, 0)
  const report = JSON.parse(await fs.readFile(path.join(evidence, 'report.json'), 'utf8'))
  assert.equal(report.stopReason, 'protocol_probe_failed')
  assert.equal(report.executedRuns, 0)
  assert.match(JSON.parse(await fs.readFile(path.join(evidence, 'probe-error.json'), 'utf8')).error, /expected deepseek-flash/)
  assert.equal(await exists(path.join(evidence, 'runs')), false)
})

test('an execute run probes, then stops at the first run with unknown usage and writes its report', async t => {
  const { manifest, manifestPath, deps, calls, evidence } = await setup(t)
  const result = await executeBatch({ manifestPath, evidenceRoot: evidence, maxUsd: manifest.reserve.batchUsd }, deps())
  assert.equal(result.stopReason, 'usage_unknown')
  assert.equal(calls.probe, 1)
  const probe = JSON.parse(await fs.readFile(path.join(evidence, 'probe.json'), 'utf8'))
  assert.equal(probe.echoedModel, batchEchoedModel)
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(evidence, 'manifest.json'), 'utf8')), manifest)
  const report = JSON.parse(await fs.readFile(path.join(evidence, 'report.json'), 'utf8'))
  assert.equal(report.mode, 'execute')
  assert.equal(report.executedRuns, 1)
  assert.equal(report.runs[0].runId, manifest.runOrder[0])
  assert.equal(report.observedModel, batchEchoedModel)
  assert.ok(report.spentPeakUsd >= manifest.reserve.probeUsd)
})

test('execute arguments are all required and the model comes only from the manifest', () => {
  assert.deepEqual(parseEvalArgs(['--execute', '--manifest', 'm.json', '--evidence-root', 'ev', '--max-usd', '28.17'], {}),
    { mode: 'execute', model: 'from-manifest', manifest: 'm.json', evidenceRoot: 'ev', maxUsd: 28.17 })
  assert.throws(() => parseEvalArgs(['--execute', '--manifest', 'm.json', '--evidence-root', 'ev'], {}), /requires --manifest/)
  assert.throws(() => parseEvalArgs(['--execute', '--manifest', 'm.json', '--evidence-root', 'ev', '--max-usd', '-1'], {}), /requires a value|positive decimal/)
  assert.throws(() => parseEvalArgs(['--execute', '--manifest', 'm.json', '--evidence-root', 'ev', '--max-usd', '1e3'], {}), /positive decimal/)
  assert.throws(() => parseEvalArgs(['--execute', '--manifest', 'm.json', '--evidence-root', 'ev', '--max-usd', '5', '--model', 'x/y'], {}), /from the frozen manifest/)
  assert.throws(() => parseEvalArgs(['--execute', '--manifest', 'm.json', '--evidence-root', 'ev', '--max-usd', '5'], { MINI_DSH_EVAL_MODEL: 'x/y' }), /from the frozen manifest/)
  assert.throws(() => parseEvalArgs(['--plan-only', '--max-usd', '5'], {}), /only valid with --execute/)
})
