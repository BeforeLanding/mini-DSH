import { blindIds, boundedIds, ledgerIds, screeningIds, sequenceIds } from './coding-fixtures.js'
import type { FixtureId } from './coding-fixtures.js'
import { batchPhases, ledgerPhases, phaseCaps } from './eval-runner.js'
import type { LedgerPhase, PhaseName } from './eval-runner.js'

// 真实适配器评测入口的参数解析与计划推算，全部是纯函数：不读环境变量、不碰文件系统、不发请求。
// 抽出来的理由是「可离线验收」——eval-screening.ts 有顶层 await（协议探测、批次执行），被测试 import
// 会真的发起付费请求，所以这些判据不能只住在那个文件里。env 一律由调用方传入。
const phaseNames: readonly PhaseName[] = [...batchPhases, 'sequence', 'smoke', 'blind', ...ledgerPhases]
const flagOptions = new Set(['probe-only', 'plan-only'])
const valueOptions = new Set(['phase', 'tasks', 'infeasible', 'infeasible-reason', 'input-target'])

export interface EvalOptions {
  phase: PhaseName
  tasks?: string
  infeasible?: string
  infeasibleReason?: string
  inputTarget?: string
  probeOnly: boolean
  planOnly: boolean
}

// 阶段 → 该阶段允许出现的 fixture 清单。默认计划取整份清单，`--tasks` 只能在其内部取子集：允许跨阶段
// 取任务会让「--tasks pipeline 挂在 screening 阶段」这类错误重新出现，而它恰好会让第 13 个计划任务
// 撞上 runs = 12 的上限，把「跑了 12 个」读成「筛出了 12 个」。
// 两臂用同一份任务集是刻意的：对照 A 比较的是上下文策略，不是任务难度；臂之间的差异只由 armPolicy 承担。
export function phaseRegistry(phase: PhaseName): readonly FixtureId[] {
  switch (phase) {
    case 'screening': return screeningIds
    case 'armA':
    case 'armB':
    case 'sequence': return sequenceIds
    // smoke 是 NX-08f 的诊断烟测：跑对照 B 的仪器（单任务 audit），一次运行，用来回答「真实模型会不会
    // 真的产生那份报告」。它与正式对照臂共用同一台仪器，但上限单独预注册、不进 batchCaps。
    case 'smoke': return boundedIds
    // blind 是 NX-08h 的诊断烟测：跑「无公开 check.mjs」的十四阶段 fixture，一次运行，用来回答
    // 「没有 oracle 之后还会不会一次做对」。它单列一份注册表（并进 sequenceIds 会让 repeatCount 抛错，
    // 也会让对照 A 的两臂拿到不同的任务集），上限单独预注册、不进 batchCaps。
    case 'blind': return blindIds
    // NX-38 的两批四条臂共用同一 fixture（ledger）与同一份任务集：臂之间的差异只由 eval-runner.ts 的
    // ledgerPolicy 承担，不来自跑了哪些任务，也不来自跑了几次。四条臂的计划因此逐字相同。
    case 'ledgerA1':
    case 'ledgerA2':
    case 'ledgerB1':
    case 'ledgerB2':
      return ledgerIds
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
    ...(parsed.has('input-target') ? { inputTarget: parsed.get('input-target') } : {}),
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

// 「一共跑几次」与「跑哪些 fixture」是两个独立的事实：registry 只说后者，`phaseCaps[phase].runs` 说
// 前者，相除就是每个 fixture 的重复数。重复数只能从**整份 registry** 推，不能从 `--tasks` 的子集推——
// 否则「只跑 2 个 fixture」会被读成「每个跑 6 遍」而多花 4 倍的钱。
// NX-08e 的事故正是这两者脱节：armA 的 runs = 3 当时只被 `overCap` 当中止阈值用，入口没有任何产生重复
// 的机制，一条命令实际只跑 1 次，而 --plan-only 还把上限当计划打印了出来。现在 runs 是唯一来源，
// 「上限」与「计划」由构造相等。
export function repeatCount(runs: number, fixtures: number): number {
  if (fixtures < 1) throw new Error('a phase registry cannot be empty')
  const repeats = runs / fixtures
  if (!Number.isSafeInteger(repeats) || repeats < 1) throw new Error(`a phase scheduled for ${runs} runs cannot be split evenly across ${fixtures} fixtures`)
  return repeats
}

// 实际执行的 run 序列：同一 fixture 的重复按次序编号，落在证据里就能分辨「第几次重复」。
export interface PlannedRun { id: FixtureId; repeat: number }

export function resolveRuns(phase: PhaseName, taskList?: string): PlannedRun[] {
  const repeats = repeatCount(phaseCaps[phase].runs, phaseRegistry(phase).length)
  return resolvePlanned(phase, taskList).flatMap(id => Array.from({ length: repeats }, (_, repeat) => ({ id, repeat })))
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

// `--input-target` 是批次 A 第二臂（ledgerA2）**唯一**的自变量，且只由它消费。两条越界各自失败，
// 理由与 `--tasks` 的越界报错同一类：把裁剪目标悄悄塞进一条不改裁剪的臂，账面上看不出来。
export function resolveInputTarget(phase: PhaseName, raw?: string): number | undefined {
  if (raw === undefined) {
    // 缺目标时静默退回默认值会让「裁 / 不裁」两臂退化成同一臂——那正是这个参数存在的理由。
    if (phase === 'ledgerA2') throw new Error('--phase ledgerA2 requires --input-target derived from the ledgerA1 peaks')
    return undefined
  }
  if (phase !== 'ledgerA2') throw new Error(`--input-target is only consumed by --phase ledgerA2, not ${phase}`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`--input-target must be a positive safe integer, got ${raw}`)
  return value
}

// NX-38-3 预注册写死的推导规则：A2 的裁剪目标 = floor(0.75 × A1 逐阶段峰值估算输入的最大值)。
// 0.75 与离线证明（test/nx38-covenant.test.ts 的 targetFor）同一个系数；floor 保证目标不高于实测峰值的
// 3/4，从而让裁剪真的会触发。空数组抛错而不是让 -Infinity 流到命令行里。
export function derivePruningTarget(peaks: readonly number[]): number {
  if (!peaks.length) throw new Error('cannot derive a pruning target from an empty peak list')
  return Math.floor(Math.max(...peaks) * 0.75)
}

// 证据行的形状（`runs.jsonl` 每行是 `{phase, fixture, repeat, ...RunOutcome}`）。只声明推导需要的那两个
// 字段，避免把评测运行器的类型拖进这个纯函数模块。
export interface LedgerRunRecord {
  phase?: string
  tasks?: readonly { maxEstimatedInputTokens?: number }[]
}

// 从证据复原预注册写死的那串数：「峰值取 A1 每次运行 context/projection 的 maxEstimatedInputTokens，
// 再跨 A1 的重复取最大」。每条记录是一次运行，取该 run 各阶段的最大值。
// phase 不符即抛错——防止把 A2 或 B 批的结果误当 A1 的基线，那正是「按结果挑仪器」的形状。
export function ledgerRunPeaks(records: readonly LedgerRunRecord[], phase: LedgerPhase = 'ledgerA1'): number[] {
  return records.map(record => {
    if (record.phase !== phase) throw new Error(`evidence came from ${String(record.phase)}, expected ${phase}`)
    const peaks = (record.tasks ?? []).map(stage => stage.maxEstimatedInputTokens ?? 0)
    if (!peaks.length) throw new Error(`a ${phase} run recorded no stage projections; nothing to derive from`)
    return Math.max(...peaks)
  })
}

// 窗口能力必须明确：官方端点取 PLAN 保守配置的 1,000,000，自定义端点不允许靠模型名猜。
export function resolveContextWindow(env: Record<string, string | undefined>, baseUrl: string): number {
  const declared = env.MINI_DSH_EVAL_CONTEXT_WINDOW
  const contextWindowTokens = declared ? Number(declared) : baseUrl === 'https://api.deepseek.com' ? 1_000_000 : undefined
  if (contextWindowTokens === undefined) throw new Error('MINI_DSH_EVAL_CONTEXT_WINDOW is required for a non-official endpoint')
  if (!Number.isSafeInteger(contextWindowTokens) || contextWindowTokens <= 0) throw new Error('MINI_DSH_EVAL_CONTEXT_WINDOW must be a positive safe integer')
  return contextWindowTokens
}
