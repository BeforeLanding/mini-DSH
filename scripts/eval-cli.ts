import { screeningIds, sequenceIds } from './coding-fixtures.js'
import type { FixtureId } from './coding-fixtures.js'
import { batchPhases } from './eval-runner.js'
import type { PhaseName } from './eval-runner.js'

// 真实适配器评测入口的参数解析与计划推算，全部是纯函数：不读环境变量、不碰文件系统、不发请求。
// 抽出来的理由是「可离线验收」——eval-screening.ts 有顶层 await（协议探测、批次执行），被测试 import
// 会真的发起付费请求，所以这些判据不能只住在那个文件里。env 一律由调用方传入。
const phaseNames: readonly PhaseName[] = [...batchPhases, 'sequence']
const flagOptions = new Set(['probe-only', 'plan-only'])
const valueOptions = new Set(['phase', 'tasks', 'infeasible', 'infeasible-reason'])

export interface EvalOptions {
  phase: PhaseName
  tasks?: string
  infeasible?: string
  infeasibleReason?: string
  probeOnly: boolean
  planOnly: boolean
}

// 阶段 → 该阶段允许出现的 fixture 清单。默认计划取整份清单，`--tasks` 只能在其内部取子集：允许跨阶段
// 取任务会让「--tasks pipeline 挂在 screening 阶段」这类错误重新出现，而它恰好会让第 13 个计划任务
// 撞上 runs = 12 的上限，把「跑了 12 个」读成「筛出了 12 个」。
export function phaseRegistry(phase: PhaseName): readonly FixtureId[] {
  switch (phase) {
    case 'screening': return screeningIds
    case 'sequence': return sequenceIds
    // 对照臂的任务集还没定：PLAN 里的旧算式（12 任务 × 2 臂 × 3 次）在 fixture 变成多阶段序列后作废，
    // 要等 NX-08e2 的烟测结论重算。在此之前让 armA/armB 直接失败，好过悄悄沿用一份已经不成立的任务集。
    default: throw new Error(`${phase} 的任务集尚未预注册：对照臂要等 NX-08e2 的烟测结论重算 phaseCaps 与任务集（见 PLAN 的 NX-08 评测批次上限）`)
  }
}

export function parseEvalArguments(argv: readonly string[]): EvalOptions {
  const parsed = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`)
    const [name, inline] = token.slice(2).split('=', 2)
    if (flagOptions.has(name)) {
      if (inline !== undefined) throw new Error(`--${name} takes no value`)
      parsed.set(name, '')
      continue
    }
    if (!valueOptions.has(name)) throw new Error(`unknown option: --${name}`)
    const value = inline ?? argv[++index]
    if (value === undefined || value === '' || value.startsWith('--')) throw new Error(`--${name} needs a value`)
    parsed.set(name, value)
  }
  const phase = parsed.get('phase') ?? 'screening'
  if (!phaseNames.includes(phase as PhaseName)) throw new Error(`unknown phase: ${phase}; expected one of ${phaseNames.join(', ')}`)
  return {
    phase: phase as PhaseName,
    ...(parsed.has('tasks') ? { tasks: parsed.get('tasks') } : {}),
    ...(parsed.has('infeasible') ? { infeasible: parsed.get('infeasible') } : {}),
    ...(parsed.has('infeasible-reason') ? { infeasibleReason: parsed.get('infeasible-reason') } : {}),
    probeOnly: parsed.has('probe-only'),
    planOnly: parsed.has('plan-only'),
  }
}

export function resolvePlanned(phase: PhaseName, taskList?: string): FixtureId[] {
  const registry = phaseRegistry(phase)
  if (taskList === undefined) return [...registry]
  const requested = taskList.split(',').map(name => name.trim())
  if (requested.some(name => !name)) throw new Error('--tasks must name fixture ids, e.g. --tasks boundary,merge')
  const outside = requested.filter(name => !registry.includes(name as FixtureId))
  if (outside.length) throw new Error(`--tasks names fixtures outside the ${phase} phase: ${outside.join(', ')}`)
  if (new Set(requested).size !== requested.length) throw new Error('duplicate fixture ids in --tasks')
  return requested as FixtureId[]
}

// 证据目录按「阶段 + 覆盖范围」分开放，并一次一跑：同一范围重复运行时调用方会拒绝写入（见入口脚本的
// ensureWritable），避免「整体重跑」被误读成「同一次运行的追加」。只有恰好取了该阶段整份清单才算
// full，否则用实际的 id 拼接，让目录名自己说明覆盖到哪。
export function evidenceScope(phase: PhaseName, planned: readonly FixtureId[]): string {
  const registry = phaseRegistry(phase)
  const whole = planned.length === registry.length && planned.every((id, index) => id === registry[index])
  return whole ? 'full' : planned.join('-')
}

// 不可行是人的判断且影响成功率分母，因此必须同时给出理由，否则不允许利用这个口径。
export function resolveInfeasible(phase: PhaseName, ids?: string, reason?: string): { ids: Set<FixtureId>; reason?: string } {
  if (ids === undefined) {
    if (reason !== undefined) throw new Error('--infeasible-reason without --infeasible')
    return { ids: new Set<FixtureId>(), reason: undefined }
  }
  const parsed = resolvePlanned(phase, ids)
  if (reason === undefined || !reason.trim()) throw new Error('--infeasible requires --infeasible-reason explaining why the task is unsolvable as specified')
  return { ids: new Set(parsed), reason: reason.trim() }
}

export function resolveModel(env: Record<string, string | undefined>): string {
  const value = env.MINI_DSH_EVAL_MODEL ?? env.MINI_DSH_MODEL
  if (value === undefined || !value.trim()) throw new Error('MINI_DSH_MODEL is required; refusing to fall back to the adapter default list')
  return value.trim()
}

// 窗口能力必须明确：官方端点取 PLAN 保守配置的 1,000,000，自定义端点不允许靠模型名猜。
export function resolveContextWindow(env: Record<string, string | undefined>, baseUrl: string): number {
  const declared = env.MINI_DSH_EVAL_CONTEXT_WINDOW
  const contextWindowTokens = declared ? Number(declared) : baseUrl === 'https://api.deepseek.com' ? 1_000_000 : undefined
  if (contextWindowTokens === undefined) throw new Error('MINI_DSH_EVAL_CONTEXT_WINDOW is required for a non-official endpoint')
  if (!Number.isSafeInteger(contextWindowTokens) || contextWindowTokens <= 0) throw new Error('MINI_DSH_EVAL_CONTEXT_WINDOW must be a positive safe integer')
  return contextWindowTokens
}
