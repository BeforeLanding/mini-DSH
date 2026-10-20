import path from 'node:path'

// R10 的离线适配层。这里不运行 Docker、不下载数据集、不调用模型；它只固定正式实验需要的
// 选择、预算、路径映射、预测格式与汇总口径，好在取得授权后不做“先跑再改协议”。
export interface SwebenchInstance {
  instance_id: string
  repo: string
  base_commit: string
  version?: string
  environment_setup_commit?: string
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

export interface EpisodeRecord {
  instanceId: string
  resolved: boolean
  status: 'completed' | 'timeout' | 'budget' | 'infrastructure' | 'failed'
  costUsd?: number
  usageUnknown?: boolean
}

export function summarizeEpisodes(records: readonly EpisodeRecord[]) {
  const total = records.length
  const resolved = records.filter(record => record.resolved).length
  const infrastructure = records.filter(record => record.status === 'infrastructure').length
  const unknownCost = records.filter(record => record.usageUnknown || record.costUsd === undefined).length
  const known = records.filter(record => record.costUsd !== undefined && !record.usageUnknown)
  const knownCost = known.reduce((sum, record) => sum + record.costUsd!, 0)
  return {
    total,
    resolved,
    resolvedRate: total ? resolved / total : 0,
    infrastructure,
    timeouts: records.filter(record => record.status === 'timeout').length,
    budgetStops: records.filter(record => record.status === 'budget').length,
    failed: records.filter(record => record.status === 'failed').length,
    knownCostUsd: Number(knownCost.toFixed(9)),
    unknownCostEpisodes: unknownCost,
    denominator: 'all planned episodes; infrastructure failures are not silently dropped',
  }
}
