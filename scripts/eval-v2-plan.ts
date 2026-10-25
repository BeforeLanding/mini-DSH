import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ablationPolicy, promptLayoutPolicy, toolOutputPolicy } from './eval-runner.js'
import type { AblationPhase, PromptLayoutMode, ToolOutputMode } from './eval-runner.js'
import type { BudgetPolicy } from '../src/core/budget.js'

export type V2Split = 'calibration' | 'formal' | 'development' | 'component'
export type V2Tier = '2m' | '1m'
export type V2Family = 'comprehension' | 'bugfix' | 'feature' | 'refactor' | 'mutation'
export type V2Shape = 'single' | 'cross-module' | 'information' | 'multi-stage'
export type V2Protocol = 'NX-42-eval-v2' | 'NX-42-eval-v2.1' | 'NX-45-dev-2arm-v1' | 'NX-50-component-ab-v1'
export interface V2Task { id: string; family: V2Family; shape: V2Shape }
export interface V2Options { split: V2Split; tier: V2Tier; window: number; evidenceRoot: string; planOnly: boolean }
export interface V2Episode { taskId: string; repeat: number; arm: AblationPhase; block: number }
export interface V2Arm { name: AblationPhase; budget: Readonly<BudgetPolicy>; toolOutput: ToolOutputMode; promptLayout: PromptLayoutMode }

const families: readonly [string, V2Family][] = [
  ['U', 'comprehension'], ['B', 'bugfix'], ['F', 'feature'], ['R', 'refactor'], ['T', 'mutation'],
]
const shapes: readonly V2Shape[] = ['single', 'cross-module', 'information', 'multi-stage']
export const formalTasks: readonly V2Task[] = Object.freeze(families.flatMap(([prefix, family]) =>
  shapes.map((shape, index) => Object.freeze({ id: `${prefix}${String(index + 1).padStart(2, '0')}`, family, shape }))))
export const calibrationTasks: readonly V2Task[] = Object.freeze(families.map(([prefix, family]) =>
  Object.freeze({ id: `${prefix}C01`, family, shape: family === 'comprehension' || family === 'refactor' ? 'multi-stage' : 'information' as V2Shape })))
// Structural selection only: all five existing calibration roots plus the first
// single-stage comprehension root. U01 becomes development data once used here.
export const developmentTasks: readonly V2Task[] = Object.freeze([...calibrationTasks, formalTasks[0]!])
// Six formal roots that have never appeared in a real-model batch. Once used
// here they are development data and must not be presented as an untouched
// formal holdout. The set spans all five families and all four shapes.
export const componentTasks: readonly V2Task[] = Object.freeze([
  Object.freeze({ id: 'U02', family: 'comprehension', shape: 'cross-module' }),
  Object.freeze({ id: 'B03', family: 'bugfix', shape: 'information' }),
  Object.freeze({ id: 'F01', family: 'feature', shape: 'single' }),
  Object.freeze({ id: 'F02', family: 'feature', shape: 'cross-module' }),
  Object.freeze({ id: 'R04', family: 'refactor', shape: 'multi-stage' }),
  Object.freeze({ id: 'T04', family: 'mutation', shape: 'multi-stage' }),
])

export const v2Arms = ['baseline', 'context', 'prompt', 'full'] as const
export const calibrationArms = ['baseline', 'full'] as const
export const componentArms = ['context'] as const
export const v2ScheduleSeed = 20261015
export const developmentScheduleSeed = 20261017
export const componentScheduleSeed = 20261025
const assertNever = (value: never): never => { throw new Error(`unhandled V2 split: ${String(value)}`) }
export const tasksForV2Split = (split: V2Split): readonly V2Task[] => {
  switch (split) {
    case 'formal': return formalTasks
    case 'calibration': return calibrationTasks
    case 'development': return developmentTasks
    case 'component': return componentTasks
    default: return assertNever(split)
  }
}
export const armsForV2Split = (split: V2Split): readonly AblationPhase[] => {
  switch (split) {
    case 'formal': return v2Arms
    case 'calibration': return calibrationArms
    case 'development': return calibrationArms
    case 'component': return componentArms
    default: return assertNever(split)
  }
}
export const repeatsForV2Split = (split: V2Split): number => {
  switch (split) {
    case 'formal': return 3
    case 'calibration': return 2
    case 'development': return 2
    case 'component': return 2
    default: return assertNever(split)
  }
}
export const seedForV2Split = (split: V2Split): number => {
  switch (split) {
    case 'formal': return v2ScheduleSeed
    case 'calibration': return v2ScheduleSeed
    case 'development': return developmentScheduleSeed
    case 'component': return componentScheduleSeed
    default: return assertNever(split)
  }
}
export const protocolForV2Split = (split: V2Split): V2Protocol => {
  switch (split) {
    case 'formal':
    case 'calibration': return 'NX-42-eval-v2.1'
    case 'development': return 'NX-45-dev-2arm-v1'
    case 'component': return 'NX-50-component-ab-v1'
    default: return assertNever(split)
  }
}
// A block is the unit that is scheduled together. Formal schedules four arms,
// calibration/development two, and the component version batches one.
export const blockSizeForV2Split = (split: V2Split): number => armsForV2Split(split).length
const fixtureRoot = fileURLToPath(new URL('../../test/fixtures/harness-v2/', import.meta.url))

const positive = (value: string, flag: string): number => {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive safe integer`)
  return parsed
}

export function parseV2Arguments(argv: readonly string[]): V2Options {
  const values = new Map<string, string>()
  const allowed = new Set(['split', 'tier', 'window', 'evidence-root', 'plan-only'])
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === undefined || !token.startsWith('--')) throw new Error(`unexpected argument: ${String(token)}`)
    const [key, inline] = token.slice(2).split('=', 2)
    if (key === undefined || !allowed.has(key)) throw new Error(`unknown option: --${String(key)}`)
    if (values.has(key)) throw new Error(`duplicate option: --${key}`)
    if (key === 'plan-only') {
      if (inline !== undefined) throw new Error('--plan-only takes no value')
      values.set(key, '')
      continue
    }
    const value = inline ?? argv[++index]
    if (!value || value.startsWith('--')) throw new Error(`--${key} needs a value`)
    values.set(key, value)
  }
  const split = values.get('split')
  if (split !== 'calibration' && split !== 'formal' && split !== 'development' && split !== 'component') throw new Error('--split must be calibration, component, development or formal')
  const tier = values.get('tier')
  if (tier !== '2m' && tier !== '1m') throw new Error('--tier must be 2m or 1m; choose the formal tier after calibration')
  if ((split === 'development' || split === 'component') && tier !== '1m') throw new Error(`${split} protocol requires the shared 1m tier`)
  const window = positive(values.get('window') ?? '', '--window')
  if (window <= 65_536) throw new Error('--window must exceed the managed input target of 65,536 tokens')
  const evidenceRoot = values.get('evidence-root')
  if (!evidenceRoot) throw new Error('--evidence-root is required')
  return { split, tier, window, evidenceRoot: path.resolve(evidenceRoot), planOnly: values.has('plan-only') }
}

export function assertEvidenceRootUnused(root: string): void {
  if (fs.existsSync(root)) throw new Error(`evidence root already exists: ${root}`)
}

export function resolveV2Arms(window: number, tier: V2Tier): readonly V2Arm[] {
  if (!Number.isSafeInteger(window) || window <= 65_536) throw new Error('model window must exceed 65,536 tokens')
  const total = tier === '2m' ? 2_000_000 : 1_000_000
  return v2Arms.map(name => Object.freeze({
    name,
    budget: Object.freeze({ ...ablationPolicy(name, window), maxModelRequests: 64, maxToolCalls: 128, maxActiveDurationMs: 600_000, maxTotalTokens: total }),
    toolOutput: toolOutputPolicy(name)!,
    promptLayout: promptLayoutPolicy(name)!,
  }))
}

export interface V2ReserveOptions { arm?: AblationPhase; episodes?: number; tier?: V2Tier; window?: number }
export function developmentReserveUsd(
  price: { inputPerMillion: number; outputPerMillion: number; cacheReadPerMillion: number },
  options: V2ReserveOptions = {},
) {
  if ([price.inputPerMillion, price.outputPerMillion, price.cacheReadPerMillion].some(value => !Number.isFinite(value) || value < 0)) throw new Error('invalid development price')
  const arm = options.arm ?? 'baseline', episodes = options.episodes ?? 24
  const tier = options.tier ?? '1m', window = options.window ?? 1_000_000
  if (!Number.isSafeInteger(episodes) || episodes <= 0) throw new Error('reserve episodes must be a positive safe integer')
  const selected = resolveV2Arms(window, tier).find(candidate => candidate.name === arm)
  if (!selected) throw new Error(`reserve arm is not registered: ${arm}`)
  const budget = selected.budget
  const maxRate = Math.max(price.inputPerMillion, price.outputPerMillion, price.cacheReadPerMillion)
  const tokenBudgetUsd = budget.maxTotalTokens! * maxRate / 1_000_000
  const marginUsd = tokenBudgetUsd * 0.2
  const finalRequestUsd = price.inputPerMillion + budget.maxOutputTokens! * price.outputPerMillion / 1_000_000
  const perEpisodeUsd = tokenBudgetUsd + marginUsd + finalRequestUsd
  const probeUsd = 16_384 * maxRate / 1_000_000
  return { arm, episodes, tier, window, tokenBudgetUsd, marginUsd, finalRequestUsd, perEpisodeUsd, probeUsd, batchUsd: perEpisodeUsd * episodes + probeUsd }
}

export function resolveV2Episodes(split: V2Split): readonly V2Episode[] {
  const tasks = tasksForV2Split(split)
  const arms = armsForV2Split(split)
  const repeats = repeatsForV2Split(split)
  const result: V2Episode[] = []
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    // Fisher-Yates with a protocol-fixed seed controls order only; model decoding is not seeded.
    const ordered = [...tasks]
    let state = (seedForV2Split(split) ^ repeat) >>> 0
    for (let cursor = ordered.length - 1; cursor > 0; cursor -= 1) {
      state ^= state << 13; state ^= state >>> 17; state ^= state << 5
      const target = (state >>> 0) % (cursor + 1)
      ;[ordered[cursor], ordered[target]] = [ordered[target]!, ordered[cursor]!]
    }
    for (const [index, task] of ordered.entries()) {
      const offset = (index + repeat) % arms.length
      for (let position = 0; position < arms.length; position += 1) result.push({
        taskId: task.id, repeat, arm: arms[(offset + position) % arms.length]!, block: repeat * tasks.length + index,
      })
    }
  }
  return result
}

export function resolveV2Plan(options: V2Options) {
  const tasks = tasksForV2Split(options.split)
  const episodes = resolveV2Episodes(options.split)
  const arms = resolveV2Arms(options.window, options.tier).filter(arm => armsForV2Split(options.split).includes(arm.name))
  const perEpisode = arms[0]!.budget
  return {
    protocol: protocolForV2Split(options.split), scheduleSeed: seedForV2Split(options.split), split: options.split, tier: options.tier, evidenceRoot: options.evidenceRoot,
    modelWindowTokens: options.window, tasks, arms, episodes,
    caps: { runs: episodes.length, modelRequests: episodes.length * perEpisode.maxModelRequests!, toolCalls: episodes.length * perEpisode.maxToolCalls!, totalTokens: episodes.length * perEpisode.maxTotalTokens!, activeDurationMs: episodes.length * perEpisode.maxActiveDurationMs! },
    readiness: { fixturesPresent: tasks.filter(task => fs.existsSync(path.join(fixtureRoot, task.id))).length, fixturesPlanned: tasks.length },
  }
}
