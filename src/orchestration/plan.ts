import { SandboxRuntime } from '../core/sandbox-runtime.js'
import { planInputError } from './validation.js'
import type { PlanInput, SubtaskSpec } from './contracts.js'

// 计划校验是宿主职责（DEVELOPMENT.md §4.4）：结构、路径、DAG、同波次写集、
// 验收命令形状与单/并行判定。模型只能提出计划，任何一项失败都不派发。
const normalize = (value: string) => value.replace(/\\/g, '/').replace(/^\.\//, '')
const comparable = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value
interface PathEntry { key: string; directory: boolean }
function pathEntry(value: string): PathEntry {
  const normalized = comparable(normalize(value))
  return { key: normalized.endsWith('/') ? normalized.slice(0, -1) : normalized, directory: normalized.endsWith('/') }
}
// 写集条目要么是文件（精确匹配），要么是以 / 结尾的目录前缀。
// 同一路径、目录与其后代视为相交；`src/` 与 `src2/` 不相交。
export function pathsOverlap(left: string, right: string) {
  const a = pathEntry(left), b = pathEntry(right)
  if (a.key === b.key) return true
  if (a.directory && b.key.startsWith(`${a.key}/`)) return true
  if (b.directory && a.key.startsWith(`${b.key}/`)) return true
  return false
}
export const DEFAULT_PROTECTED_PATHS: readonly string[] = Object.freeze(['.git/', '.mini-dsh/'])

export interface PlanCheckOptions {
  maxSubtasks?: number
  mode?: 'auto' | 'single' | 'parallel'
  protectedPaths?: readonly string[]
  workspace?: string
  inspectCommand?: (command: string) => { action: 'allow' | 'deny'; reason?: string | undefined }
}
export interface PlanDecisionResult {
  plan: PlanInput
  waves: string[][]
  mode: 'single' | 'parallel'
  reason: string
}
export type PlanValidationResult = { ok: true; decision: PlanDecisionResult } | { ok: false; errors: string[] }

function planWaves(plan: PlanInput): { ok: true; waves: string[][] } | { ok: false; errors: string[] } {
  const deps = new Map(plan.subtasks.map(subtask => [subtask.id, subtask.dependsOn ?? []]))
  const dependents = new Map(plan.subtasks.map(subtask => [subtask.id, [] as string[]]))
  for (const subtask of plan.subtasks) for (const dependency of deps.get(subtask.id)!) dependents.get(dependency)!.push(subtask.id)
  const remaining = new Map(plan.subtasks.map(subtask => [subtask.id, deps.get(subtask.id)!.length]))
  const level = new Map(plan.subtasks.map(subtask => [subtask.id, 0]))
  const queue = plan.subtasks.filter(subtask => remaining.get(subtask.id) === 0).map(subtask => subtask.id)
  let processed = 0
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index]!
    processed++
    for (const dependent of dependents.get(id)!) {
      level.set(dependent, Math.max(level.get(dependent)!, level.get(id)! + 1))
      remaining.set(dependent, remaining.get(dependent)! - 1)
      if (remaining.get(dependent) === 0) queue.push(dependent)
    }
  }
  if (processed !== plan.subtasks.length) {
    const cyclic = plan.subtasks.filter(subtask => (remaining.get(subtask.id) ?? 0) > 0).map(subtask => subtask.id)
    return { ok: false, errors: [`plan.dependsOn contains a cycle involving: ${cyclic.join(', ')}`] }
  }
  const waves: string[][] = []
  for (const subtask of plan.subtasks) {
    const index = level.get(subtask.id)!
    while (waves.length <= index) waves.push([])
    waves[index]!.push(subtask.id)
  }
  return { ok: true, waves }
}

function checkWriteSets(plan: PlanInput, protectedPaths: readonly string[]): string[] {
  const errors: string[] = []
  for (const subtask of plan.subtasks) {
    if (new Set(subtask.writeSet).size !== subtask.writeSet.length) errors.push(`${subtask.id}.writeSet contains duplicate paths`)
    for (const entry of subtask.writeSet) {
      if (protectedPaths.some(protectedPath => pathsOverlap(entry, protectedPath))) errors.push(`${subtask.id}.writeSet may not target protected path: ${entry}`)
    }
  }
  return errors
}

function checkWaves(plan: PlanInput, waves: string[][]): string[] {
  const byId = new Map(plan.subtasks.map(subtask => [subtask.id, subtask]))
  const errors: string[] = []
  for (const [index, wave] of waves.entries()) {
    for (let left = 0; left < wave.length; left++) for (let right = left + 1; right < wave.length; right++) {
      const a = byId.get(wave[left]!)!, b = byId.get(wave[right]!)!
      const collision = a.writeSet.flatMap(first => b.writeSet.filter(second => pathsOverlap(first, second)).map(second => `${first} <-> ${second}`))
      if (collision.length) errors.push(`wave ${index + 1} has overlapping write sets: ${a.id} (${a.writeSet.join(', ')}) and ${b.id} (${b.writeSet.join(', ')}): ${collision.join(', ')}`)
    }
  }
  return errors
}

function checkCommands(plan: PlanInput, inspect: (command: string) => { action: 'allow' | 'deny'; reason?: string | undefined }): string[] {
  const errors: string[] = []
  for (const subtask of plan.subtasks) for (const command of subtask.acceptance.commands) {
    const result = inspect(command)
    if (result.action !== 'allow') errors.push(`${subtask.id}.acceptance command is not allowed by the workspace command gate: ${command}${result.reason ? ` (${result.reason})` : ''}`)
  }
  return errors
}

// 校验顺序固定，错误信息稳定；同一个计划在任何机器上得到同样的波次与判定。
export function validatePlan(value: unknown, options: PlanCheckOptions = {}): PlanValidationResult {
  const structural = planInputError(value)
  if (structural) return { ok: false, errors: [structural] }
  const plan = value as PlanInput
  const maxSubtasks = options.maxSubtasks ?? 4
  const errors: string[] = []
  if (plan.subtasks.length > maxSubtasks) errors.push(`plan.subtasks exceeds maxSubtasks (${maxSubtasks})`)
  errors.push(...checkWriteSets(plan, options.protectedPaths ?? DEFAULT_PROTECTED_PATHS))
  const waveResult = planWaves(plan)
  if (!waveResult.ok) return { ok: false, errors: [...errors, ...waveResult.errors] }
  errors.push(...checkWaves(plan, waveResult.waves))
  // 显式构造一次闸门，所有验收命令共用同一 workspace。
  const gate = options.inspectCommand ? undefined : new SandboxRuntime({ workspace: options.workspace ?? process.cwd() })
  const inspectCommand = options.inspectCommand ?? ((command: string) => gate!.inspectCommand(command))
  errors.push(...checkCommands(plan, inspectCommand))
  if (errors.length) return { ok: false, errors }
  const parallelWave = waveResult.waves.findIndex(wave => wave.length >= 2)
  const requested = options.mode ?? 'auto'
  if (requested === 'parallel' && parallelWave < 0) return { ok: false, errors: ['parallel mode requires at least one wave with two or more subtasks'] }
  const parallel = requested === 'parallel' || (requested === 'auto' && parallelWave >= 0)
  const waves = waveResult.waves
  const reason = parallel
    ? `wave ${parallelWave + 1} runs ${waves[parallelWave]!.length} independent subtasks`
    : requested === 'single'
      ? 'user selected single mode; subtasks run one at a time'
      : 'no wave contains two independent subtasks; subtasks run one at a time'
  return { ok: true, decision: { plan, waves, mode: parallel ? 'parallel' : 'single', reason } }
}
export function subtaskById(plan: PlanInput, subtaskId: string): SubtaskSpec | undefined {
  return plan.subtasks.find(subtask => subtask.id === subtaskId)
}
