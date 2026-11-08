import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { CLI_BUDGET } from '../src/core/budget.js'
import type { ArmId, RunSpec, TaskBudget } from './eval-orchestrate.js'
import type { SmokeManifest } from './smoke-manifest.js'

// 四臂付费小批次的**冻结与金额上限**（DEVELOPMENT.md §14.4、TASKS M4-⑤-1）。本模块不创建模型适配器、
// 不读取 API key；它只把一次批次要用的矩阵、模型、价格与上限冻结成 manifest，供 `--execute` 逐字核对。
// 不从 eval-orchestrate.ts 导入运行时值（只导入类型），避免与 CLI 入口形成模块环。
export type BatchPrice = SmokeManifest['price']
export const batchProtocol = 'orchestration-four-arm-v1'
export const batchModel = 'deepseek/deepseek-flash'
// 价格页把 `deepseek-flash` 列为模型名；服务端实际回显由 `--execute` 的协议探测确认，与此不符即停批。
export const batchEchoedModel = 'deepseek-flash'
export const batchMaxOutputTokens = CLI_BUDGET.maxOutputTokens!
export const batchContextWindowTokens = 1_000_000
export const batchProbeOutputTokens = 16_384
// 2026-11-08 从官方价格页核对：峰值与 2026-10-27 快照相同；非峰值为一半。上限一律按峰值计，
// 因此无论何时开跑都不会低估。
export const orchestrationPriceSnapshot: Readonly<BatchPrice> = Object.freeze({
  source: 'https://api-docs.deepseek.com/quick_start/pricing/', capturedAt: '2026-11-08T06:21:23Z', currency: 'USD',
  peakCacheReadPerMillion: 0.006, peakInputPerMillion: 0.30, peakOutputPerMillion: 1.20,
})

export function assertBatchPrice(price: BatchPrice) {
  const values = [price.peakCacheReadPerMillion, price.peakInputPerMillion, price.peakOutputPerMillion]
  if (values.some(value => !Number.isFinite(value) || value < 0)) throw new Error('invalid batch price')
  if (price.currency !== 'USD' || !price.source || Number.isNaN(Date.parse(price.capturedAt))) throw new Error('batch price needs USD, a source and capturedAt')
}

// 与 `developmentReserveUsd`（scripts/eval-v2-plan.ts）同一公式：整 run token 上限 × 最高单价，加 20% 余量，
// 再加一次满上下文输入 + 满输出的末请求；批次 = Σ run + 协议探测预留。
export interface BatchReserve {
  runs: number
  maxRatePerMillion: number
  tokenBudgetUsd: number
  marginUsd: number
  finalRequestUsd: number
  perRunUsd: number
  probeUsd: number
  batchUsd: number
}
export function batchReserveUsd(specs: readonly Pick<RunSpec, 'budget'>[], price: BatchPrice = orchestrationPriceSnapshot, maxOutputTokens = batchMaxOutputTokens): BatchReserve {
  assertBatchPrice(price)
  if (!specs.length) throw new Error('batch reserve needs at least one run')
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0) throw new Error('batch reserve needs a positive output ceiling')
  const maxRate = Math.max(price.peakCacheReadPerMillion, price.peakInputPerMillion, price.peakOutputPerMillion)
  const finalRequestUsd = price.peakInputPerMillion * batchContextWindowTokens / 1_000_000 + maxOutputTokens * price.peakOutputPerMillion / 1_000_000
  let tokenBudgetUsd = 0
  for (const spec of specs) tokenBudgetUsd += spec.budget.maxTotalTokens * maxRate / 1_000_000
  const marginUsd = tokenBudgetUsd * 0.2
  const perRunUsd = (tokenBudgetUsd + marginUsd) / specs.length + finalRequestUsd
  const probeUsd = batchProbeOutputTokens * maxRate / 1_000_000
  return {
    runs: specs.length, maxRatePerMillion: maxRate, tokenBudgetUsd, marginUsd, finalRequestUsd: finalRequestUsd * specs.length,
    perRunUsd, probeUsd, batchUsd: tokenBudgetUsd + marginUsd + finalRequestUsd * specs.length + probeUsd,
  }
}

// 执行顺序：按 (任务, 重复) 成块，块内四臂顺序在偶数重复上反转，减轻时间漂移对某一臂的系统性偏向。
// 同一时刻只跑一个 run，墙钟在臂间可比。
export function batchExecutionOrder(specs: readonly RunSpec[]): RunSpec[] {
  const blocks = new Map<string, RunSpec[]>()
  for (const spec of specs) {
    const key = `${spec.taskId}:${spec.repeat}`
    blocks.set(key, [...(blocks.get(key) ?? []), spec])
  }
  return [...blocks.values()].flatMap(block => (block[0]!.repeat % 2 === 0 ? [...block].reverse() : block))
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
// spec 中隐藏验收器的脚本路径是本机绝对路径；digest 只取与仓库相对的形状，换 checkout 目录不影响核对。
export function matrixDigest(specs: readonly RunSpec[]) {
  const portable = specs.map(spec => ({
    ...spec,
    acceptance: { ...spec.acceptance, tasks: spec.acceptance.tasks.map(task => ({ ...task, script: task.script.replaceAll('\\', '/').replace(/^.*\/test\/fixtures\//, 'test/fixtures/') })) },
  }))
  return sha256(JSON.stringify(portable))
}

export interface BatchManifest {
  protocol: typeof batchProtocol
  createdAt: string
  gitCommit: string
  model: string
  echoedModel: string
  price: BatchPrice
  maxOutputTokens: number
  contextWindowTokens: number
  budget: TaskBudget
  repeats: number
  arms: ArmId[]
  tasks: string[]
  runOrder: string[]
  matrixDigest: string
  reserve: BatchReserve
  notes: string[]
}
export function freezeBatchManifest({ specs, gitCommit, createdAt, model = batchModel, echoedModel = batchEchoedModel, price = orchestrationPriceSnapshot }: {
  specs: readonly RunSpec[]; gitCommit: string; createdAt: string; model?: string; echoedModel?: string; price?: BatchPrice
}): BatchManifest {
  if (!/^[0-9a-f]{40,64}$/.test(gitCommit)) throw new Error('batch manifest needs a full git commit')
  if (specs.some(spec => spec.model !== model)) throw new Error('every run spec must use the batch model')
  const budgets = new Set(specs.map(spec => JSON.stringify(spec.budget)))
  if (budgets.size !== 1) throw new Error('batch runs must share one task budget')
  return {
    protocol: batchProtocol, createdAt, gitCommit, model, echoedModel, price: { ...price },
    maxOutputTokens: batchMaxOutputTokens, contextWindowTokens: batchContextWindowTokens,
    budget: { ...specs[0]!.budget }, repeats: Math.max(...specs.map(spec => spec.repeat)),
    arms: [...new Set(specs.map(spec => spec.arm))], tasks: [...new Set(specs.map(spec => spec.taskId))],
    runOrder: batchExecutionOrder(specs).map(spec => spec.runId),
    matrixDigest: matrixDigest(specs), reserve: batchReserveUsd(specs, price),
    notes: [
      'R and R-serial run the fixture plan; the planner is not evaluated',
      'plannerShare=0 (no planner runs) and fixReserveTokens=0 (no integration-fix attempt exists); R and S share the same 1M root token budget',
      'orchestration workers keep the CLI 10-minute active-time limit per worker; S/D are bounded by the 30-minute task wall',
      'token categories are worker/summary only (no planner, no integration fix); duplicate-work metrics are not measured',
    ],
  }
}
export async function writeBatchManifest(file: string, manifest: BatchManifest) {
  await fs.writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
}
export function manifestDigest(manifest: BatchManifest) {
  return sha256(JSON.stringify(manifest))
}

// 冻结要求干净工作树：manifest 记录的 commit 必须就是将要执行的代码。
export function gitState(repository: string) {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' })
  const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: repository, encoding: 'utf8' })
  if (head.status !== 0 || status.status !== 0) throw new Error('cannot read git state of the evaluation checkout')
  return { head: head.stdout.trim(), dirty: status.stdout.trim().length > 0 }
}
