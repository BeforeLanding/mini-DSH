import path from 'node:path'
import type { Usage } from '../../src/core/budget.js'
import { validateCommandEnvironment } from './command-environment.js'
import type { CommandEnvironment } from './command-environment.js'
import { EXTERNAL_CONTRACT_VERSION, validateExternalCommand } from './external-contract.js'

// R10 的离线适配层。这里不运行 Docker、不下载数据集、不调用模型；它只固定正式实验需要的
// 选择、预算、路径映射、预测格式与汇总口径，好在取得授权后不做“先跑再改协议”。
export interface SwebenchInstance {
  instance_id: string
  repo: string
  base_commit: string
  version?: string
  environment_setup_commit?: string
  problem_statement?: string
  image?: string
}

// 数据集原始行包含 patch/test_patch/FAIL_TO_PASS 等金标准与隐藏判据。冻结文件只保留
// 运行所需字段；执行器还会再拒绝任何仍带这些字段的行，避免 gold 进入 Agent 输入。
const goldFields = ['patch', 'test_patch', 'FAIL_TO_PASS', 'PASS_TO_PASS', 'hints_text']
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const instanceFields = ['instance_id', 'repo', 'base_commit', 'version', 'environment_setup_commit', 'problem_statement', 'image']

export function sanitizeInstanceRow(value: unknown): SwebenchInstance {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('instance row must be an object')
  const row = value as Record<string, unknown>
  for (const key of instanceFields) {
    const field = row[key]
    if (field !== undefined && typeof field !== 'string') throw new Error(`instance ${String(row.instance_id)}: ${key} must be a string`)
  }
  if (typeof row.instance_id !== 'string' || typeof row.repo !== 'string' || typeof row.base_commit !== 'string') {
    throw new Error('instance row requires instance_id, repo and base_commit')
  }
  if (typeof row.problem_statement !== 'string' || !row.problem_statement.trim()) throw new Error(`instance ${row.instance_id}: problem_statement is required`)
  const clean: SwebenchInstance = { instance_id: row.instance_id, repo: row.repo, base_commit: row.base_commit, problem_statement: row.problem_statement }
  for (const key of ['version', 'environment_setup_commit', 'image'] as const) if (typeof row[key] === 'string') clean[key] = row[key] as string
  return clean
}

// 冻结后的执行输入必须已经脱敏；保留这条机械护栏，避免有人把原始数据集直接交给执行器。
export function assertSanitizedInstances(rows: readonly unknown[]): SwebenchInstance[] {
  return rows.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('instance row must be an object')
    for (const key of goldFields) if (key in (value as Record<string, unknown>)) throw new Error(`dataset row contains gold/hidden field ${key}; sanitize it before executing`)
    return sanitizeInstanceRow(value)
  })
}

// 正式批次与开发批次共用一份冻结文件，但各自有独立的题号、排除规则与顺序。
export interface BatchInstanceList {
  tasks: number
  seed: number
  exclusions: string[]
  instances: SwebenchInstance[]
}

// 每道题按固定 seed 旋转 arm 顺序；同一题的各 arm 相邻执行，减小时间和缓存漂移。
export function buildSchedule(instances: readonly SwebenchInstance[], arms: readonly string[], seed: number) {
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error('schedule seed must be a non-negative safe integer')
  if (!arms.length) throw new Error('schedule needs at least one arm')
  const seen = new Set<string>()
  const schedule: { instanceId: string; armId: string }[] = []
  let offset = seed % arms.length
  for (const instance of instances) {
    if (seen.has(instance.instance_id)) throw new Error(`duplicate scheduled instance: ${instance.instance_id}`)
    seen.add(instance.instance_id)
    for (let index = 0; index < arms.length; index++) schedule.push({ instanceId: instance.instance_id, armId: arms[(index + offset) % arms.length]! })
    offset = (offset + 1) % arms.length
  }
  return schedule
}


export interface SelectionOptions {
  tasks: number
  seed: number
  exclude?: readonly string[]
}

function lcg(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items]
  for (let index = copy.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1))
    ;[copy[index], copy[swap]] = [copy[swap]!, copy[index]!]
  }
  return copy
}

// 按 repository 分层、固定 seed 轮转取题。没有独立难度元数据时不造难度分层。
export function selectInstances(dataset: readonly SwebenchInstance[], options: SelectionOptions): SwebenchInstance[] {
  if (!Number.isSafeInteger(options.tasks) || options.tasks <= 0) throw new Error('tasks must be a positive safe integer')
  if (!Number.isSafeInteger(options.seed) || options.seed < 0) throw new Error('seed must be a non-negative safe integer')
  const excluded = new Set(options.exclude ?? [])
  const seen = new Set<string>()
  const groups = new Map<string, SwebenchInstance[]>()
  for (const instance of dataset) {
    if (!/^[\w.-]+__[\w.-]+-\d+$/.test(instance.instance_id)) throw new Error(`invalid instance_id: ${instance.instance_id}`)
    if (seen.has(instance.instance_id)) throw new Error(`duplicate instance_id: ${instance.instance_id}`)
    seen.add(instance.instance_id)
    if (excluded.has(instance.instance_id)) continue
    if (!instance.repo || !instance.base_commit) throw new Error(`instance ${instance.instance_id} lacks repo/base_commit`)
    const group = groups.get(instance.repo)
    if (group) group.push(instance)
    else groups.set(instance.repo, [instance])
  }
  const random = lcg(options.seed)
  const queues = [...groups.keys()].sort().map(repo => ({ repo, items: shuffled(groups.get(repo)!, random) }))
  const selected: SwebenchInstance[] = []
  while (selected.length < options.tasks && queues.some(queue => queue.items.length)) {
    for (const queue of queues) {
      const next = queue.items.shift()
      if (!next) continue
      selected.push(next)
      if (selected.length === options.tasks) break
    }
  }
  if (selected.length < options.tasks) throw new Error(`dataset has only ${selected.length} eligible instances, need ${options.tasks}`)
  return selected
}

export interface BudgetPlan {
  formalTasks: number
  arms: number
  perTaskCapUsd: number
  devTasks: number
  devRunsPerTask: number
  devPerTaskCapUsd: number
  computeReserveUsd: number
}

export function estimateBudget(plan: BudgetPlan) {
  const values = Object.entries(plan)
  for (const [name, value] of values) if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative finite number`)
  if (!Number.isSafeInteger(plan.formalTasks) || plan.formalTasks <= 0) throw new Error('formalTasks must be a positive safe integer')
  if (!Number.isSafeInteger(plan.arms) || plan.arms <= 0) throw new Error('arms must be a positive safe integer')
  const formalCeiling = plan.formalTasks * plan.arms * plan.perTaskCapUsd
  const developmentCeiling = plan.devTasks * plan.devRunsPerTask * plan.devPerTaskCapUsd
  return {
    formalCeilingUsd: Number(formalCeiling.toFixed(6)),
    developmentCeilingUsd: Number(developmentCeiling.toFixed(6)),
    totalCeilingUsd: Number((formalCeiling + developmentCeiling + plan.computeReserveUsd).toFixed(6)),
    note: 'configuration ceiling, not an expected spend; unknown usage must be reported separately',
  }
}

export interface SwebenchPrediction {
  instance_id: string
  model_name_or_path: string
  model_patch: string
}

export function validatePrediction(value: unknown): SwebenchPrediction {
  if (!value || typeof value !== 'object') throw new Error('prediction must be an object')
  const entry = value as Record<string, unknown>
  if (typeof entry.instance_id !== 'string' || !entry.instance_id) throw new Error('prediction.instance_id is required')
  if (typeof entry.model_name_or_path !== 'string' || !entry.model_name_or_path) throw new Error('prediction.model_name_or_path is required')
  if (typeof entry.model_patch !== 'string') throw new Error('prediction.model_patch must be a string (empty is allowed)')
  return { instance_id: entry.instance_id, model_name_or_path: entry.model_name_or_path, model_patch: entry.model_patch }
}

// 宿主候选目录 → 任务容器内路径。只做显式映射，不把宿主工作区原样暴露给容器。
export function mapHostToContainer(candidateRoot: string, hostPath: string, containerRoot = '/testbed') {
  const root = path.resolve(candidateRoot)
  const target = path.resolve(hostPath)
  const relative = path.relative(root, target)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('candidate path escapes its workspace')
  return relative ? path.posix.join(containerRoot, relative.split(path.sep).join('/')) : containerRoot
}

export type EpisodeStatus = 'completed' | 'timeout' | 'budget' | 'infrastructure' | 'failed' | 'cancelled'

export function classifyRunStatus(status: string): EpisodeStatus {
  if (status === 'completed') return 'completed'
  if (status === 'timeout' || status === 'request_timeout' || status === 'approval_timeout') return 'timeout'
  if (status === 'cancelled') return 'cancelled'
  if (status === 'max_steps' || status === 'max_tool_calls' || status === 'token_budget' || status === 'output_limit' || status === 'context_overflow') return 'budget'
  return 'failed'
}

export interface SwebenchArmExternal {
  commit: string | null
  command: string[] | null
  contractVersion: number | null
  version: string | null
  modelName: string | null
  upstreamConfigSha256: string | null
  installSha256: string | null
  environmentParity: string | null
  apiKeyEnv: string | null
}

export interface SwebenchArm {
  id: string
  system: 'mini-dsh' | 'external'
  role: string
  model: { provider: string; name: string | null; contextWindowTokens: number }
  external?: SwebenchArmExternal
  budget: Record<string, unknown>
}

export interface SwebenchBatchManifest {
  tasks: number
  seed: number
  exclusions: string[]
  instances: SwebenchInstance[]
  arms: string[]
  schedule: { instanceId: string; armId: string }[]
}

export interface SwebenchRunManifest {
  schemaVersion: 3
  kind: 'swebench-run-manifest'
  freezeStatus: 'draft' | 'frozen'
  dataset: { name: string; revision: string }
  harnessCommit: string
  selection: unknown
  development: SwebenchBatchManifest
  formal: SwebenchBatchManifest
  arms: SwebenchArm[]
  promptTemplate: string
  caps: {
    perTask: { maxCostUsd: number; maxModelRequests: number; maxToolCalls: number; wallClockMs: number; maxOutputTokens: number }
    developmentPerTask: { maxCostUsd: number; maxModelRequests: number; maxToolCalls: number; wallClockMs: number; maxOutputTokens: number }
    batch: { maxCostUsd: number; maxEpisodes: number }
  }
  prices: PriceSnapshot | null
  scoring: Record<string, unknown>
  environment: { imageDigests: Record<string, string> | null; commandEnvironment?: CommandEnvironment }
  authorization: string
  missing: string[]
  createdAt: string
  paidRequests: number
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`)
  return value
}

function positiveNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`)
  return value
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`)
  return value
}

function validateBatch(value: unknown, arms: readonly string[], name: string): SwebenchBatchManifest {
  if (!value || typeof value !== 'object') throw new Error(`${name} must be an object`)
  const batch = value as Record<string, unknown>
  if (!Array.isArray(batch.instances) || !Array.isArray(batch.schedule) || !Array.isArray(batch.arms)) throw new Error(`${name} is missing instances/schedule/arms`)
  if (batch.arms.length !== arms.length || batch.arms.some((arm, index) => arm !== arms[index])) throw new Error(`${name}.arms must match the manifest arms order`)
  const instances = assertSanitizedInstances(batch.instances)
  const ids = new Set(instances.map(instance => instance.instance_id))
  if (ids.size !== instances.length) throw new Error(`${name} contains duplicate instances`)
  const schedule = batch.schedule.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new Error(`${name}.schedule[${index}] must be an object`)
    const { instanceId, armId } = entry as Record<string, unknown>
    if (typeof instanceId !== 'string' || typeof armId !== 'string' || !ids.has(instanceId) || !arms.includes(armId)) throw new Error(`${name}.schedule[${index}] references an unknown instance or arm`)
    return { instanceId, armId }
  })
  if (schedule.length !== instances.length * arms.length) throw new Error(`${name}.schedule must cover every instance and arm exactly once`)
  const seen = new Set<string>()
  for (const episode of schedule) {
    const key = `${episode.instanceId}/${episode.armId}`
    if (seen.has(key)) throw new Error(`${name}.schedule repeats ${episode.instanceId}/${episode.armId}`)
    seen.add(key)
  }
  return { tasks: positiveInteger(batch.tasks, `${name}.tasks`), seed: nonNegativeInteger(batch.seed, `${name}.seed`),
    exclusions: Array.isArray(batch.exclusions) ? batch.exclusions.map(item => { if (typeof item !== 'string') throw new Error(`${name}.exclusions must be strings`); return item }) : [],
    instances, arms: [...batch.arms], schedule }
}

const hashPattern = /^[0-9a-f]{64}$/

function validateExternalArm(value: unknown, index: number, frozen: boolean): SwebenchArmExternal | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) throw new Error(`arms[${index}].external must be an object`)
  const commit = value.commit
  if (commit !== null && commit !== undefined && (typeof commit !== 'string' || !/^[0-9a-f]{7,40}$/.test(commit))) {
    throw new Error(`arms[${index}].external.commit must be a hex commit`)
  }
  if (frozen && (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit))) {
    throw new Error(`arms[${index}].external.commit must be a full 40-hex commit when frozen`)
  }
  const command = value.command
  if (command !== null && command !== undefined) {
    if (!Array.isArray(command) || command.length === 0 || command.some(item => typeof item !== 'string' || !item)) {
      throw new Error(`arms[${index}].external.command must be a non-empty string array`)
    }
    validateExternalCommand(command)
  }
  if (frozen && !Array.isArray(command)) throw new Error(`arms[${index}].external.command is required when frozen`)
  const text = (key: string, required: boolean) => {
    const item = value[key]
    if (item === null || item === undefined) {
      if (required) throw new Error(`arms[${index}].external.${key} is required when frozen`)
      return null
    }
    if (typeof item !== 'string' || !item) throw new Error(`arms[${index}].external.${key} must be a non-empty string`)
    return item
  }
  const hash = (key: string, required: boolean) => {
    const item = text(key, required)
    if (item !== null && !hashPattern.test(item)) throw new Error(`arms[${index}].external.${key} must be a lowercase SHA-256`)
    return item
  }
  const contractVersion = value.contractVersion
  if (contractVersion !== null && contractVersion !== undefined && contractVersion !== EXTERNAL_CONTRACT_VERSION) {
    throw new Error(`arms[${index}].external.contractVersion must be ${EXTERNAL_CONTRACT_VERSION}`)
  }
  if (frozen && contractVersion !== EXTERNAL_CONTRACT_VERSION) throw new Error(`arms[${index}].external.contractVersion is required when frozen`)
  const version = text('version', frozen)
  const modelName = text('modelName', frozen)
  const upstreamConfigSha256 = hash('upstreamConfigSha256', frozen)
  const installSha256 = hash('installSha256', frozen)
  const environmentParity = text('environmentParity', frozen)
  const apiKeyEnv = text('apiKeyEnv', frozen)
  if (apiKeyEnv !== null && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) throw new Error(`arms[${index}].external.apiKeyEnv is not an environment variable name`)
  return {
    commit: typeof commit === 'string' ? commit : null,
    command: Array.isArray(command) ? [...command] : null,
    contractVersion: typeof contractVersion === 'number' ? contractVersion : null,
    version, modelName, upstreamConfigSha256, installSha256, environmentParity, apiKeyEnv,
  }
}

export function validateRunManifest(value: unknown): SwebenchRunManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('run manifest must be an object')
  const manifest = value as Record<string, unknown>
  if (manifest.schemaVersion !== 3 || manifest.kind !== 'swebench-run-manifest') throw new Error('unsupported run manifest schema')
  if (manifest.freezeStatus !== 'draft' && manifest.freezeStatus !== 'frozen') throw new Error('run manifest freezeStatus must be draft or frozen')
  const frozen = manifest.freezeStatus === 'frozen'
  if (!Array.isArray(manifest.arms) || !manifest.arms.length) throw new Error('run manifest needs arms')
  const arms = manifest.arms.map((value, index) => {
    if (!value || typeof value !== 'object') throw new Error(`arms[${index}] must be an object`)
    const arm = value as Record<string, unknown>
    if (typeof arm.id !== 'string' || !arm.id || (arm.system !== 'mini-dsh' && arm.system !== 'external')) throw new Error(`arms[${index}] needs id and system`)
    if (!arm.model || typeof arm.model !== 'object') throw new Error(`arms[${index}].model is required`)
    const model = arm.model as Record<string, unknown>
    if (typeof model.provider !== 'string' || !model.provider) throw new Error(`arms[${index}].model.provider is required`)
    if (model.name !== null && typeof model.name !== 'string') throw new Error(`arms[${index}].model.name must be a string or null`)
    const contextWindowTokens = positiveInteger(model.contextWindowTokens, `arms[${index}].model.contextWindowTokens`)
    if (!arm.budget || typeof arm.budget !== 'object') throw new Error(`arms[${index}].budget is required`)
    const system = arm.system as SwebenchArm['system']
    const external = validateExternalArm(arm.external, index, frozen)
    if (system === 'external' && !external) throw new Error(`arms[${index}].external is required for an external arm`)
    if (system === 'external' && frozen && (typeof model.name !== 'string' || !model.name)) throw new Error(`arms[${index}].model.name is required when frozen`)
    if (system === 'mini-dsh' && external) throw new Error(`arms[${index}].external is only valid for an external arm`)
    return { id: arm.id, system, role: typeof arm.role === 'string' ? arm.role : '', model: { provider: model.provider, name: model.name as string | null, contextWindowTokens },
      ...(external ? { external } : {}), budget: arm.budget as Record<string, unknown> }
  })
  if (new Set(arms.map(arm => arm.id)).size !== arms.length) throw new Error('arm ids must be unique')
  const candidate = arms.find(arm => arm.id === 'candidate')
  for (const arm of arms.filter(item => item.system === 'external')) {
    if (candidate && (arm.model.provider !== candidate.model.provider || arm.model.name !== candidate.model.name)) {
      throw new Error(`external arm ${arm.id} must use the same model as candidate`)
    }
    if (arm.external?.modelName && arm.model.name && arm.external.modelName !== `${arm.model.provider}/${arm.model.name}`) {
      throw new Error(`external arm ${arm.id} modelName must be provider/model`)
    }
  }
  const ids = arms.map(arm => arm.id)
  const caps = manifest.caps as Record<string, unknown> | undefined
  if (!caps?.perTask || !caps.developmentPerTask || !caps.batch) throw new Error('run manifest caps are required')
  const perTask = caps.perTask as Record<string, unknown>, dev = caps.developmentPerTask as Record<string, unknown>, batchCaps = caps.batch as Record<string, unknown>
  for (const [name, cap] of [['caps.perTask', perTask], ['caps.developmentPerTask', dev]] as const) {
    positiveNumber(cap.maxCostUsd, `${name}.maxCostUsd`)
    positiveInteger(cap.maxModelRequests, `${name}.maxModelRequests`)
    positiveInteger(cap.maxToolCalls, `${name}.maxToolCalls`)
    positiveInteger(cap.wallClockMs, `${name}.wallClockMs`)
    positiveInteger(cap.maxOutputTokens, `${name}.maxOutputTokens`)
  }
  positiveNumber(batchCaps.maxCostUsd, 'caps.batch.maxCostUsd')
  positiveInteger(batchCaps.maxEpisodes, 'caps.batch.maxEpisodes')
  if (!manifest.dataset || typeof manifest.dataset !== 'object') throw new Error('run manifest dataset is required')
  if (typeof (manifest.dataset as Record<string, unknown>).revision !== 'string') throw new Error('dataset revision is required')
  if (typeof manifest.harnessCommit !== 'string' || !/^[0-9a-f]{7,40}$/.test(manifest.harnessCommit)) throw new Error('harnessCommit must be a git commit hash')
  if (typeof manifest.promptTemplate !== 'string' || !manifest.promptTemplate.includes('{problem_statement}')) throw new Error('promptTemplate must contain {problem_statement}')
  if (typeof manifest.paidRequests !== 'number') throw new Error('paidRequests is required')
  if (typeof manifest.createdAt !== 'string') throw new Error('createdAt is required')
  if (!manifest.environment || typeof manifest.environment !== 'object') throw new Error('environment is required')
  return {
    schemaVersion: 3, kind: 'swebench-run-manifest', freezeStatus: manifest.freezeStatus,
    dataset: { name: String((manifest.dataset as Record<string, unknown>).name ?? 'SWE-bench Verified'), revision: (manifest.dataset as Record<string, unknown>).revision as string },
    harnessCommit: manifest.harnessCommit, selection: manifest.selection,
    development: validateBatch(manifest.development, ids, 'development'),
    formal: validateBatch(manifest.formal, ids, 'formal'),
    arms, promptTemplate: manifest.promptTemplate,
    caps: { perTask: perTask as SwebenchRunManifest['caps']['perTask'], developmentPerTask: dev as SwebenchRunManifest['caps']['developmentPerTask'], batch: batchCaps as SwebenchRunManifest['caps']['batch'] },
    prices: manifest.prices === null ? null : validatePriceSnapshot(manifest.prices),
    scoring: isRecord(manifest.scoring) ? manifest.scoring : {},
    environment: { imageDigests: (manifest.environment as Record<string, unknown>).imageDigests as Record<string, string> | null ?? null,
      ...((manifest.environment as Record<string, unknown>).commandEnvironment === undefined ? {} : { commandEnvironment: validateCommandEnvironment((manifest.environment as Record<string, unknown>).commandEnvironment) }) },
    authorization: typeof manifest.authorization === 'string' ? manifest.authorization : '',
    missing: Array.isArray(manifest.missing) ? manifest.missing.map(item => String(item)) : [],
    createdAt: manifest.createdAt, paidRequests: manifest.paidRequests,
  }
}

export interface PriceSnapshot {
  currency: 'USD'
  inputUsdPerMillion: number
  cachedInputUsdPerMillion: number
  outputUsdPerMillion: number
  capturedAt: string
  source: string
}

export function validatePriceSnapshot(value: unknown): PriceSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('price snapshot must be an object')
  const price = value as Record<string, unknown>
  for (const key of ['inputUsdPerMillion', 'cachedInputUsdPerMillion', 'outputUsdPerMillion']) {
    if (typeof price[key] !== 'number' || !Number.isFinite(price[key]) || (price[key] as number) < 0) throw new Error(`price snapshot ${key} must be a non-negative finite number`)
  }
  if (price.currency !== 'USD') throw new Error('price snapshot currency must be USD')
  if (typeof price.capturedAt !== 'string' || !price.capturedAt) throw new Error('price snapshot capturedAt is required')
  if (typeof price.source !== 'string' || !price.source) throw new Error('price snapshot source is required')
  return { currency: 'USD', inputUsdPerMillion: price.inputUsdPerMillion as number, cachedInputUsdPerMillion: price.cachedInputUsdPerMillion as number,
    outputUsdPerMillion: price.outputUsdPerMillion as number, capturedAt: price.capturedAt, source: price.source }
}

// 成本只用 provider 报的 usage 估价；estimated/缺失一律 unknown，不补零。
export function usageCost(usage: readonly Usage[], prices: PriceSnapshot): { costUsd?: number; unknown: boolean; reason?: string } {
  if (!usage.length) return { unknown: true, reason: 'no model usage recorded' }
  let cost = 0
  for (const entry of usage) {
    if (entry.source !== 'provider' || entry.uncertain) return { unknown: true, reason: 'usage is estimated or uncertain' }
    const cached = entry.cacheReadTokens ?? 0
    if (cached > entry.inputTokens) return { unknown: true, reason: 'cache-read tokens exceed input tokens' }
    cost += (entry.inputTokens - cached) * prices.inputUsdPerMillion / 1_000_000
    cost += cached * prices.cachedInputUsdPerMillion / 1_000_000
    cost += entry.outputTokens * prices.outputUsdPerMillion / 1_000_000
  }
  return { costUsd: Number(cost.toFixed(9)), unknown: false }
}

// 用 price 与单题金额上限反推一个可执行的 token 上限。它用两种单价中的较大者，
// 因而 usage 的真实成本不会超过这个上限（保守但可机械执行）。
export function tokenCapFromUsd(maxCostUsd: number, prices: PriceSnapshot): number {
  if (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0) throw new Error('per-task cost cap must be positive')
  const worst = Math.max(prices.inputUsdPerMillion, prices.cachedInputUsdPerMillion, prices.outputUsdPerMillion)
  if (worst <= 0) throw new Error('price snapshot has no positive unit price; cannot derive a token cap')
  return Math.max(1, Math.floor(maxCostUsd * 1_000_000 / worst))
}

export function wilsonInterval(successes: number, total: number, z = 1.959963984540054) {
  if (!Number.isSafeInteger(successes) || !Number.isSafeInteger(total) || successes < 0 || total < 0 || successes > total) throw new Error('invalid Wilson inputs')
  if (total === 0) return { low: 0, high: 1 }
  const p = successes / total
  const denominator = 1 + z * z / total
  const center = (p + z * z / (2 * total)) / denominator
  const margin = z * Math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / denominator
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) }
}

function binomialCoefficient(n: number, k: number) {
  let result = 1
  for (let index = 1; index <= k; index++) result = result * (n - k + index) / index
  return result
}

// 精确 McNemar（双侧二项检验）。不一致对数很少时不要用卡方近似。
export function mcnemarExact(onlyA: number, onlyB: number) {
  if (!Number.isSafeInteger(onlyA) || !Number.isSafeInteger(onlyB) || onlyA < 0 || onlyB < 0) throw new Error('invalid McNemar inputs')
  const discordant = onlyA + onlyB
  if (discordant === 0) return 1
  const tail = Math.min(onlyA, onlyB)
  let probability = 0
  for (let index = 0; index <= tail; index++) probability += binomialCoefficient(discordant, index)
  return Math.min(1, 2 * probability / 2 ** discordant)
}

export function pairedFourCell(a: ReadonlyMap<string, boolean>, b: ReadonlyMap<string, boolean>) {
  const keys = [...a.keys()].sort()
  if (keys.length !== b.size || keys.some(key => !b.has(key))) throw new Error('paired arms must cover the same instances')
  let both = 0, onlyA = 0, onlyB = 0, neither = 0
  for (const key of keys) {
    const left = a.get(key)!, right = b.get(key)!
    if (left && right) both++
    else if (left) onlyA++
    else if (right) onlyB++
    else neither++
  }
  return {
    bothResolved: both, onlyA, onlyB, neither,
    total: keys.length,
    rateDifference: keys.length ? (aTrueCount(a) - aTrueCount(b)) / keys.length : 0,
    mcnemarExactP: mcnemarExact(onlyA, onlyB),
    note: 'exact two-sided McNemar on discordant pairs; small samples are descriptive only',
  }
}

function aTrueCount(values: ReadonlyMap<string, boolean>) { let count = 0; for (const value of values.values()) if (value) count++; return count }

export interface EpisodeRecord {
  instanceId: string
  resolved: boolean
  status: EpisodeStatus
  costUsd?: number
  usageUnknown?: boolean
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  durationMs?: number
  modelRequests?: number
  toolCalls?: number
}

function median(values: readonly number[]) {
  if (!values.length) return undefined
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

export function summarizeEpisodes(records: readonly EpisodeRecord[]) {
  const total = records.length
  const resolved = records.filter(record => record.resolved).length
  const infrastructure = records.filter(record => record.status === 'infrastructure').length
  const unknownCost = records.filter(record => record.usageUnknown || record.costUsd === undefined).length
  const known = records.filter(record => record.costUsd !== undefined && !record.usageUnknown)
  const knownCost = known.reduce((sum, record) => sum + record.costUsd!, 0)
  const knownTokens = records.filter(record => !record.usageUnknown)
  const sum = (field: 'inputTokens' | 'outputTokens' | 'cacheReadTokens') => knownTokens.reduce((total, record) => total + (record[field] ?? 0), 0)
  return {
    total,
    resolved,
    resolvedRate: total ? resolved / total : 0,
    wilson95: wilsonInterval(resolved, total),
    infrastructure,
    timeouts: records.filter(record => record.status === 'timeout').length,
    budgetStops: records.filter(record => record.status === 'budget').length,
    failed: records.filter(record => record.status === 'failed').length,
    cancelled: records.filter(record => record.status === 'cancelled').length,
    statusCounts: Object.fromEntries((['completed', 'timeout', 'budget', 'infrastructure', 'failed', 'cancelled'] as const)
      .map(status => [status, records.filter(record => record.status === status).length])),
    knownCostUsd: Number(knownCost.toFixed(9)),
    unknownCostEpisodes: unknownCost,
    usageKnownEpisodes: knownTokens.length,
    usageMissingRatio: total ? unknownCost / total : 0,
    averageKnownCostUsd: total ? Number((knownCost / total).toFixed(9)) : 0,
    medianKnownCostUsd: median(known.map(record => record.costUsd!)),
    tokens: { input: sum('inputTokens'), output: sum('outputTokens'), cacheRead: sum('cacheReadTokens') },
    denominator: 'all planned episodes; infrastructure failures are not silently dropped',
  }
}
