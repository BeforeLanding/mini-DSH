import fs from 'node:fs/promises'
import path from 'node:path'
import { buildSchedule, estimateBudget, sanitizeInstanceRow, selectInstances, validatePriceSnapshot } from './protocol.js'
import type { BatchInstanceList, SwebenchInstance } from './protocol.js'

// 使用前必须给出真实 dataset revision、官方 harness commit 与预算参数。该脚本只冻结协议，
// 不下载数据集、不构建镜像、不调用模型。它同时写出开发批次与正式批次的题号、排除规则和交错顺序；
// 只有所有必填配置齐备且显式 --finalize 时才把 freezeStatus 写成 frozen，执行器拒绝 draft。
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

function numberArgument(name: string, fallback?: number) {
  const raw = optionalArgument(name)
  if (raw === undefined) {
    if (fallback === undefined) throw new Error(`missing ${name}`)
    return fallback
  }
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`)
  return value
}

const defaultPrompt = `You are working in a repository checkout for a GitHub issue. Make the smallest correct change that resolves the issue. You may inspect and edit files and run commands in the current workspace. Do not modify hidden tests or grading data. When the change is complete, stop and reply with a short summary.

Issue:
{problem_statement}
`

async function main() {
  const datasetPath = argument('--dataset')
  const out = path.resolve(argument('--out'))
  const dataset = JSON.parse(await fs.readFile(datasetPath, 'utf8')) as unknown
  if (!Array.isArray(dataset)) throw new Error('dataset must be a JSON array of instances')
  // 原始行里的 patch/test_patch/FAIL_TO_PASS 到此为止：冻结文件只保留脱敏字段。
  const sanitized = dataset.map(sanitizeInstanceRow)
  const tasks = numberArgument('--tasks')
  const seed = numberArgument('--seed')
  const datasetRevision = argument('--dataset-revision')
  const harnessCommit = argument('--harness-commit')
  if (!/^[0-9a-f]{7,40}$/.test(harnessCommit)) throw new Error('--harness-commit must be a git commit hash')
  const arms = numberArgument('--arms', 4)
  if (!Number.isSafeInteger(arms) || arms < 1 || arms > 4) throw new Error('--arms must be 1..4')
  const perTaskCapUsd = numberArgument('--per-task-cap-usd', 0.5)
  const devTasks = numberArgument('--dev-tasks', 5)
  const devSeed = numberArgument('--dev-seed', seed + 1)
  const devPerTaskCapUsd = numberArgument('--dev-per-task-cap-usd', perTaskCapUsd)
  const computeReserveUsd = numberArgument('--compute-reserve-usd', 0)
  const batchCapUsd = numberArgument('--batch-cap-usd', Number.NaN)
  const maxRequests = numberArgument('--max-requests', 64)
  const maxToolCalls = numberArgument('--max-tool-calls', 128)
  const wallClockMs = numberArgument('--wall-clock-ms', 900_000)
  const maxOutputTokens = numberArgument('--max-output-tokens', 16_384)
  const scheduleSeed = numberArgument('--schedule-seed', seed)
  const exclusions = optionalArgument('--exclude') ? JSON.parse(await fs.readFile(argument('--exclude'), 'utf8')) as unknown : []
  if (!Array.isArray(exclusions) || !exclusions.every(item => typeof item === 'string')) throw new Error('exclusions must be a JSON array of instance ids')

  const development = selectInstances(sanitized, { tasks: devTasks, seed: devSeed })
  const formal = selectInstances(sanitized, { tasks, seed, exclude: [...exclusions, ...development.map(instance => instance.instance_id)] })

  // 同题两臂只改变声明的维度：context 两臂都保留 65,536 输入目标，reference 仅关掉自动/溢出摘要。
  const armDefinitions = [
    { id: 'candidate', system: 'mini-dsh', role: 'capability candidate', budget: { inputTargetTokens: 65_536 } },
    { id: 'baseline', system: 'external', role: 'same-model capability baseline (mini-SWE-agent)', budget: {} },
    { id: 'context-reference', system: 'mini-dsh', role: 'context strategy reference: no active or overflow summary', budget: { inputTargetTokens: 65_536, auto: false } },
    { id: 'context-proposed', system: 'mini-dsh', role: 'context strategy proposed: repository compaction policy', budget: { inputTargetTokens: 65_536 } },
  ].slice(0, arms)

  const model = optionalArgument('--model')
  const modelProvider = optionalArgument('--model-provider') ?? 'deepseek'
  const contextWindowTokens = numberArgument('--context-window-tokens', 1_000_000)
  if (!Number.isSafeInteger(contextWindowTokens) || contextWindowTokens <= 0) throw new Error('--context-window-tokens must be a positive safe integer')
  const baselineModel = optionalArgument('--baseline-model') ?? model
  const baselineCommit = optionalArgument('--baseline-commit')
  let baselineCommand: string[] | undefined
  const baselineCommandRaw = optionalArgument('--baseline-command')
  if (baselineCommandRaw) {
    const parsed = JSON.parse(baselineCommandRaw) as unknown
    if (!Array.isArray(parsed) || !parsed.every(item => typeof item === 'string') || !parsed.length) throw new Error('--baseline-command must be a JSON array of strings')
    baselineCommand = parsed
  }
  const prices = optionalArgument('--prices') ? validatePriceSnapshot(JSON.parse(await fs.readFile(argument('--prices'), 'utf8'))) : null
  const promptTemplate = optionalArgument('--prompt-template') ? await fs.readFile(argument('--prompt-template'), 'utf8') : defaultPrompt
  if (!promptTemplate.includes('{problem_statement}')) throw new Error('prompt template must contain {problem_statement}')
  const imageDigests = optionalArgument('--image-digests') ? JSON.parse(await fs.readFile(argument('--image-digests'), 'utf8')) as Record<string, string> : undefined
  if (imageDigests && (!Object.values(imageDigests).every(value => typeof value === 'string' && value.length > 0))) throw new Error('image digests must map instance ids to digest strings')
  const covered = (instances: readonly SwebenchInstance[]) => imageDigests !== undefined && instances.every(instance => typeof imageDigests[instance.instance_id] === 'string')

  const configuredArms = armDefinitions.map(arm => ({
    ...arm,
    model: { provider: modelProvider, name: arm.id === 'baseline' ? baselineModel : model, contextWindowTokens },
    ...(arm.id === 'baseline' ? { external: { commit: baselineCommit ?? null, command: baselineCommand ?? null } } : {}),
    budget: { ...arm.budget, maxModelRequests: maxRequests, maxToolCalls, maxActiveDurationMs: wallClockMs, maxOutputTokens },
  }))

  const budget = estimateBudget({ formalTasks: tasks, arms, perTaskCapUsd, devTasks, devRunsPerTask: arms, devPerTaskCapUsd, computeReserveUsd })
  const effectiveBatchCap = Number.isFinite(batchCapUsd) ? batchCapUsd : budget.totalCeilingUsd
  const missing: string[] = []
  if (!model) missing.push('candidate model id (--model)')
  if (!prices) missing.push('price snapshot with official source and capture date (--prices)')
  if (configuredArms.some(arm => arm.id === 'baseline') && (!baselineCommit || !baselineCommand)) missing.push('same-model baseline commit and invocation (--baseline-commit/--baseline-command)')
  if (!covered(formal) || !covered(development)) missing.push('per-instance image digests for both batches (--image-digests)')
  if (effectiveBatchCap <= 0) missing.push('positive batch hard cap (--batch-cap-usd)')
  const finalized = process.argv.includes('--finalize')

  const developmentBatch: BatchInstanceList & { arms: string[]; schedule: ReturnType<typeof buildSchedule> } = {
    tasks: devTasks, seed: devSeed, exclusions: [], instances: development,
    arms: configuredArms.map(arm => arm.id), schedule: buildSchedule(development, configuredArms.map(arm => arm.id), scheduleSeed),
  }
  const formalBatch: BatchInstanceList & { arms: string[]; schedule: ReturnType<typeof buildSchedule> } = {
    tasks, seed, exclusions: [...exclusions, ...development.map(instance => instance.instance_id)], instances: formal,
    arms: configuredArms.map(arm => arm.id), schedule: buildSchedule(formal, configuredArms.map(arm => arm.id), scheduleSeed),
  }

  const manifest = {
    schemaVersion: 2,
    kind: 'swebench-run-manifest',
    freezeStatus: finalized && missing.length === 0 ? 'frozen' : 'draft',
    dataset: { name: 'SWE-bench Verified', revision: datasetRevision },
    harnessCommit,
    selection: {
      development: { tasks: devTasks, seed: devSeed, rule: 'repository-stratified round robin after a seeded within-repo shuffle; selected first and excluded from the formal batch' },
      formal: { tasks, seed, exclusions: formalBatch.exclusions, rule: 'repository-stratified round robin after a seeded within-repo shuffle; no difficulty stratification, no result-based selection' },
      scheduleSeed,
    },
    development: developmentBatch,
    formal: formalBatch,
    arms: configuredArms,
    promptTemplate,
    caps: {
      perTask: { maxCostUsd: perTaskCapUsd, maxModelRequests: maxRequests, maxToolCalls, wallClockMs, maxOutputTokens },
      developmentPerTask: { maxCostUsd: devPerTaskCapUsd, maxModelRequests: maxRequests, maxToolCalls, wallClockMs, maxOutputTokens },
      batch: { maxCostUsd: effectiveBatchCap, maxEpisodes: developmentBatch.schedule.length + formalBatch.schedule.length },
    },
    prices,
    scoring: {
      metric: 'resolved@1 on the fixed subset',
      denominator: 'all planned tasks per arm; infrastructure failures stay in the main denominator and are listed separately',
      firstAttemptOnly: true,
      providerRetry: 'same task run, fully accounted',
      statistics: 'paired four-cell counts first; Wilson 95% interval per arm; exact two-sided McNemar for paired arms; small samples are descriptive only',
      failureTraces: 'first provider failure, first budget stop, first logically wrong completed episode with a non-empty patch; absent classes are reported as absent',
      newRunIdPerBatch: true,
    },
    environment: { imageDigests: imageDigests ?? null },
    authorization: 'not granted by this file; paid model calls require explicit user approval per batch',
    missing,
    createdAt: new Date().toISOString(),
    paidRequests: 0,
  }
  await fs.mkdir(path.dirname(out), { recursive: true })
  await fs.writeFile(out, JSON.stringify(manifest, null, 2) + '\n')
  console.log(`wrote ${out}: development ${development.length}, formal ${formal.length}, arms ${configuredArms.length}, ` +
    `budget ceiling $${budget.totalCeilingUsd.toFixed(2)}, freeze ${manifest.freezeStatus}${missing.length ? `, missing: ${missing.join('; ')}` : ''}, paid requests 0`)
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
