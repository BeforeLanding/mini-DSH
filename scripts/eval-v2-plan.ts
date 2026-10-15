import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ablationPolicy, promptLayoutPolicy, toolOutputPolicy } from './eval-runner.js'
import type { AblationPhase, PromptLayoutMode, ToolOutputMode } from './eval-runner.js'
import type { BudgetPolicy } from '../src/core/budget.js'

export type V2Split = 'calibration' | 'formal'
export type V2Tier = '2m' | '1m'
export type V2Family = 'comprehension' | 'bugfix' | 'feature' | 'refactor' | 'mutation'
export type V2Shape = 'single' | 'cross-module' | 'information' | 'multi-stage'
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

export const v2Arms = ['baseline', 'context', 'prompt', 'full'] as const
export const calibrationArms = ['baseline', 'full'] as const
export const v2ScheduleSeed = 20261015
const fixtureRoot = fileURLToPath(new URL('../../test/fixtures/coding/', import.meta.url))

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
  if (split !== 'calibration' && split !== 'formal') throw new Error('--split must be calibration or formal')
  const tier = values.get('tier')
  if (tier !== '2m' && tier !== '1m') throw new Error('--tier must be 2m or 1m; choose the formal tier after calibration')
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

export function resolveV2Episodes(split: V2Split): readonly V2Episode[] {
  const tasks = split === 'formal' ? formalTasks : calibrationTasks
  const arms = split === 'formal' ? v2Arms : calibrationArms
  const repeats = split === 'formal' ? 3 : 2
  const result: V2Episode[] = []
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    // Fisher-Yates with a protocol-fixed seed controls order only; model decoding is not seeded.
    const ordered = [...tasks]
    let state = (v2ScheduleSeed ^ repeat) >>> 0
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
  const tasks = options.split === 'formal' ? formalTasks : calibrationTasks
  const episodes = resolveV2Episodes(options.split)
  const arms = resolveV2Arms(options.window, options.tier).filter(arm => options.split === 'formal' || arm.name === 'baseline' || arm.name === 'full')
  const perEpisode = arms[0]!.budget
  return {
    protocol: 'NX-42-eval-v2', scheduleSeed: v2ScheduleSeed, split: options.split, tier: options.tier, evidenceRoot: options.evidenceRoot,
    modelWindowTokens: options.window, tasks, arms, episodes,
    caps: { runs: episodes.length, modelRequests: episodes.length * perEpisode.maxModelRequests!, toolCalls: episodes.length * perEpisode.maxToolCalls!, totalTokens: episodes.length * perEpisode.maxTotalTokens!, activeDurationMs: episodes.length * perEpisode.maxActiveDurationMs! },
    readiness: { fixturesPresent: tasks.filter(task => fs.existsSync(path.join(fixtureRoot, task.id))).length, fixturesPlanned: tasks.length },
  }
}
