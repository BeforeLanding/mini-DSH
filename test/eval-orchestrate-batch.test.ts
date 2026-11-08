import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  batchExecutionOrder, batchModel, batchReserveUsd, freezeBatchManifest, matrixDigest,
  orchestrationPriceSnapshot, writeBatchManifest,
} from '../scripts/eval-orchestrate-batch.js'
import { assembleRunMatrix, parseEvalArgs, planBatch } from '../scripts/eval-orchestrate.js'

const commit = 'a'.repeat(40)
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`)

test('the batch ceiling uses the eval-v2 reserve formula at peak prices', () => {
  const specs = assembleRunMatrix({ model: batchModel })
  const reserve = batchReserveUsd(specs)
  assert.equal(reserve.runs, 16)
  assert.equal(reserve.maxRatePerMillion, 1.2)
  close(reserve.tokenBudgetUsd, 16 * 1.2)
  close(reserve.marginUsd, 16 * 1.2 * 0.2)
  // 末请求：满 1M 上下文按峰值输入价 + 16,384 输出 token。
  close(reserve.finalRequestUsd, 16 * (0.3 + 16_384 * 1.2 / 1_000_000))
  close(reserve.probeUsd, 16_384 * 1.2 / 1_000_000)
  close(reserve.batchUsd, reserve.tokenBudgetUsd + reserve.marginUsd + reserve.finalRequestUsd + reserve.probeUsd)
  close(reserve.batchUsd, 28.1742336)
  assert.throws(() => batchReserveUsd([]), /at least one run/)
  assert.throws(() => batchReserveUsd(specs, { ...orchestrationPriceSnapshot, peakOutputPerMillion: -1 }), /invalid batch price/)
})

test('runs execute in task/repeat blocks with the arm order reversed on even repeats', () => {
  const specs = assembleRunMatrix({ model: batchModel })
  const order = batchExecutionOrder(specs)
  assert.equal(order.length, specs.length)
  assert.deepEqual(new Set(order.map(spec => spec.runId)), new Set(specs.map(spec => spec.runId)))
  for (let block = 0; block < order.length; block += 4) {
    const slice = order.slice(block, block + 4)
    assert.equal(new Set(slice.map(spec => `${spec.taskId}:${spec.repeat}`)).size, 1)
    const arms = slice.map(spec => spec.arm)
    assert.deepEqual(arms, slice[0]!.repeat % 2 === 0 ? ['R-serial', 'R', 'D', 'S'] : ['S', 'D', 'R', 'R-serial'])
  }
})

test('the manifest freezes one model, one budget and a portable matrix digest', () => {
  const specs = assembleRunMatrix({ model: batchModel })
  const manifest = freezeBatchManifest({ specs, gitCommit: commit, createdAt: '2026-11-08T00:00:00.000Z' })
  assert.equal(manifest.model, batchModel)
  assert.equal(manifest.runOrder.length, 16)
  assert.deepEqual(manifest.budget, specs[0]!.budget)
  assert.equal(manifest.price.capturedAt, orchestrationPriceSnapshot.capturedAt)
  assert.throws(() => freezeBatchManifest({ specs, gitCommit: 'abc', createdAt: 'x' }), /full git commit/)
  assert.throws(() => freezeBatchManifest({ specs: assembleRunMatrix({ model: 'other/model' }), gitCommit: commit, createdAt: 'x' }), /batch model/)
  const uneven = structuredClone(specs)
  uneven[3]!.budget.maxTotalTokens += 1
  assert.throws(() => freezeBatchManifest({ specs: uneven, gitCommit: commit, createdAt: 'x' }), /share one task budget/)
  // 隐藏验收器的绝对路径随 checkout 目录变化，digest 不应随之变化；改动预算则必须变化。
  const moved = structuredClone(specs)
  for (const spec of moved) for (const task of spec.acceptance.tasks) task.script = task.script.replace(/^.*?([\\/]test[\\/]fixtures[\\/])/, '/elsewhere/checkout$1')
  assert.equal(matrixDigest(moved), matrixDigest(specs))
  assert.notEqual(matrixDigest(uneven), matrixDigest(specs))
})

test('a frozen manifest is never overwritten', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-batch-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'manifest.json')
  const manifest = freezeBatchManifest({ specs: assembleRunMatrix({ model: batchModel }), gitCommit: commit, createdAt: '2026-11-08T00:00:00.000Z' })
  await writeBatchManifest(file, manifest)
  await assert.rejects(writeBatchManifest(file, manifest), /EEXIST/)
})

test('plan-only freezes only from a clean tree and makes no provider request', async t => {
  const repository = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-plan-'))
  t.after(() => fs.rm(repository, { recursive: true, force: true }))
  const git = (...args: string[]) => assert.equal(spawnSync('git', args, { cwd: repository }).status, 0, `git ${args.join(' ')}`)
  git('init', '-q')
  git('-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '--allow-empty', '-m', 'base')
  const now = () => new Date('2026-11-08T00:00:00.000Z')
  const preview = await planBatch({ repository, now })
  assert.equal(preview.providerRequests, 0)
  assert.equal(preview.manifestWritten, null)
  assert.equal(preview.manifest.reserve.runs, 16)
  const out = path.join(repository, '..', `${path.basename(repository)}-manifest.json`)
  t.after(() => fs.rm(out, { force: true }))
  await fs.writeFile(path.join(repository, 'dirty.txt'), 'x')
  await assert.rejects(planBatch({ repository, manifestOut: out, now }), /dirty working tree/)
  await fs.rm(path.join(repository, 'dirty.txt'))
  const frozen = await planBatch({ repository, manifestOut: out, now })
  assert.equal(frozen.manifestWritten, out)
  assert.deepEqual(JSON.parse(await fs.readFile(out, 'utf8')), frozen.manifest)
})

test('plan-only is preregistered for deepseek-flash and manifest-out needs plan-only', () => {
  assert.deepEqual(parseEvalArgs(['--plan-only'], {}), { mode: 'plan-only', model: batchModel })
  assert.deepEqual(parseEvalArgs(['--plan-only', '--manifest-out', 'm.json'], {}), { mode: 'plan-only', model: batchModel, manifestOut: 'm.json' })
  assert.throws(() => parseEvalArgs(['--plan-only', '--model', 'deepseek/deepseek-v4-pro'], {}), /preregistered/)
  assert.throws(() => parseEvalArgs(['--validate-only', '--manifest-out', 'm.json'], {}), /only valid with --plan-only/)
  assert.throws(() => parseEvalArgs(['--validate-only', '--plan-only'], {}), /exactly one/)
  assert.throws(() => parseEvalArgs(['--plan-only', '--manifest-out'], {}), /requires a value/)
})
