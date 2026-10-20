import fs from 'node:fs/promises'
import path from 'node:path'
import { estimateBudget, selectInstances } from './protocol.js'
import type { SwebenchInstance } from './protocol.js'

// 使用前必须给出真实 dataset revision、官方 harness commit 与预算参数。该脚本只冻结协议，
// 不下载数据集、不构建镜像、不调用模型；镜像 digest 与运行价格在 PoC 后显式补齐。
function argument(name: string) {
  const value = optionalArgument(name)
  if (value === undefined) throw new Error(`missing ${name}`)
  return value
}

function optionalArgument(name: string) {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`missing ${name}`)
  return value
}

async function main() {
  const datasetPath = argument('--dataset')
  const out = path.resolve(argument('--out'))
  const dataset = JSON.parse(await fs.readFile(datasetPath, 'utf8')) as unknown
  if (!Array.isArray(dataset)) throw new Error('dataset must be a JSON array of instances')
  const tasks = Number(argument('--tasks'))
  const seed = Number(argument('--seed'))
  const datasetRevision = argument('--dataset-revision')
  const harnessCommit = argument('--harness-commit')
  const arms = Number(optionalArgument('--arms') ?? '4')
  const perTaskCapUsd = Number(optionalArgument('--per-task-cap-usd') ?? '0.5')
  const devTasks = Number(optionalArgument('--dev-tasks') ?? '5')
  const devRunsPerTask = Number(optionalArgument('--dev-runs-per-task') ?? '1')
  const devPerTaskCapUsd = Number(optionalArgument('--dev-per-task-cap-usd') ?? String(perTaskCapUsd))
  const computeReserveUsd = Number(optionalArgument('--compute-reserve-usd') ?? '0')
  const exclusions = process.argv.includes('--exclude') ? JSON.parse(await fs.readFile(argument('--exclude'), 'utf8')) as unknown : []
  if (!Array.isArray(exclusions) || !exclusions.every(item => typeof item === 'string')) throw new Error('exclusions must be a JSON array of instance ids')
  if (!/^[0-9a-f]{7,40}$/.test(harnessCommit)) throw new Error('--harness-commit must be a git commit hash')
  const selected = selectInstances(dataset as SwebenchInstance[], { tasks, seed, exclude: exclusions })
  const budget = estimateBudget({ formalTasks: tasks, arms, perTaskCapUsd, devTasks, devRunsPerTask, devPerTaskCapUsd, computeReserveUsd })
  const manifest = {
    schemaVersion: 1,
    kind: 'swebench-verified-subset-preregistration',
    dataset: { name: 'SWE-bench Verified', revision: datasetRevision },
    harnessCommit,
    selection: { tasks, seed, exclusions, rule: 'repository-stratified round robin after a seeded within-repo shuffle; no difficulty stratification' },
    instances: selected,
    arms: [
      { name: 'candidate', system: 'mini-DSH', role: 'capability candidate' },
      { name: 'baseline', system: 'mini-SWE-agent', role: 'same-model capability baseline', note: 'must use the same provider/model and per-task caps; otherwise report different-system results only' },
      { name: 'context-reference', system: 'mini-DSH', role: 'context strategy reference' },
      { name: 'context-proposed', system: 'mini-DSH', role: 'context strategy proposed', note: 'only the compaction strategy changes between the context arms' },
    ].slice(0, arms),
    budget,
    scoring: {
      metric: 'resolved@1 on the fixed subset',
      denominator: 'all planned tasks per arm; infrastructure failures stay in the main denominator and are also listed separately',
      firstAttemptOnly: true,
      providerRetry: 'same task run, fully accounted',
      statistics: 'report paired four-cell counts first; Wilson intervals per arm; small samples do not justify a significance claim',
    },
    environment: { imageDigestPolicy: 'per-instance official task image digest to be frozen after the no-model PoC', imageDigests: null },
    missing: ['official task image digests', 'price snapshot reconciled with provider billing'],
    createdAt: new Date().toISOString(),
    paidRequests: 0,
  }
  await fs.mkdir(path.dirname(out), { recursive: true })
  await fs.writeFile(out, JSON.stringify(manifest, null, 2) + '\n')
  console.log(`wrote ${out}: ${selected.length} tasks, budget ceiling $${budget.totalCeilingUsd.toFixed(2)}, paid requests 0`)
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
