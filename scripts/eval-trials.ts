import { wilsonInterval } from './swebench/protocol.js'
import type { SwebenchRunManifest } from './swebench/protocol.js'
import type { SwebenchEpisodeResult, SwebenchScores } from './swebench/report.js'

// 评测可信度（ET-1）：把"计划了多少、执行了多少、能判出多少"分开计数。
// 判决只有 pass / fail / unknown；unknown 必带原因，grader 错误既不算任务失败也不被静默跳过。
export type UnknownReason = 'infrastructure' | 'grader_error' | 'missing_evidence'
export const unknownReasons: readonly UnknownReason[] = ['infrastructure', 'grader_error', 'missing_evidence']

export interface PlannedTrial { taskId: string; arm: string; repeat: number }
export type TrialRecord = PlannedTrial & ({ verdict: 'pass' | 'fail'; reason?: undefined } | { verdict: 'unknown'; reason: UnknownReason })

export const trialKey = (trial: PlannedTrial) => `${trial.taskId}:${trial.arm}:${trial.repeat}`

export interface RatioWithInterval { passed: number; denominator: number; rate: number | null; wilson95: { low: number; high: number }; basis: string }
export interface ArmTrials {
  arm: string
  planned: number
  failed: number
  delivery: RatioWithInterval
  gradable: RatioWithInterval
  coverage: { executed: number; notExecuted: number; infrastructure: number; grader_error: number; missing_evidence: number }
}

const ratio = (passed: number, denominator: number, basis: string): RatioWithInterval => ({
  passed, denominator, rate: denominator ? passed / denominator : null, wilson95: wilsonInterval(passed, denominator), basis,
})

// 重复 key 与计划外记录直接抛错（与 swebench/run.ts 的 resume 口径一致）；缺失记录计入"未执行"。
export function summarizeTrials(planned: readonly PlannedTrial[], records: readonly TrialRecord[]): ArmTrials[] {
  const plannedKeys = new Set<string>()
  const arms: string[] = []
  for (const trial of planned) {
    const key = trialKey(trial)
    if (plannedKeys.has(key)) throw new Error(`duplicate planned trial: ${key}`)
    plannedKeys.add(key)
    if (!arms.includes(trial.arm)) arms.push(trial.arm)
  }
  const recordByKey = new Map<string, TrialRecord>()
  for (const record of records) {
    const key = trialKey(record)
    if (!plannedKeys.has(key)) throw new Error(`record outside the planned trials: ${key}`)
    if (recordByKey.has(key)) throw new Error(`duplicate record: ${key}`)
    if (record.verdict === 'unknown' && !unknownReasons.includes(record.reason)) throw new Error(`unknown verdict needs a reason: ${key}`)
    if (record.verdict !== 'unknown' && record.reason !== undefined) throw new Error(`only unknown verdicts carry a reason: ${key}`)
    recordByKey.set(key, record)
  }
  return arms.map(arm => {
    const scoped = planned.filter(trial => trial.arm === arm)
    const found = scoped.flatMap(trial => recordByKey.get(trialKey(trial)) ?? [])
    const passed = found.filter(record => record.verdict === 'pass').length
    const failed = found.filter(record => record.verdict === 'fail').length
    const unknownCount = (reason: UnknownReason) => found.filter(record => record.reason === reason).length
    return {
      arm, planned: scoped.length, failed,
      delivery: ratio(passed, scoped.length, 'pass / planned trials; unexecuted and unknown trials count against delivery'),
      gradable: ratio(passed, passed + failed, 'pass / (pass + fail); unknown trials are excluded and listed under coverage'),
      coverage: {
        executed: found.length, notExecuted: scoped.length - found.length,
        infrastructure: unknownCount('infrastructure'), grader_error: unknownCount('grader_error'), missing_evidence: unknownCount('missing_evidence'),
      },
    }
  })
}

// --- SWE：计划取自 manifest.schedule，记录取自 runs.jsonl 与 scores.json ---
export function sweTrials(manifest: SwebenchRunManifest, split: 'development' | 'formal', runs: readonly SwebenchEpisodeResult[], scores: SwebenchScores) {
  const planned: PlannedTrial[] = manifest[split].schedule.map(entry => ({ taskId: entry.instanceId, arm: entry.armId, repeat: 1 }))
  // 评分与执行记录同口径：重复评分、计划外评分直接抛错，不能让后一条静默覆盖前一条。
  const plannedKeys = new Set(planned.map(trial => `${trial.arm}/${trial.taskId}`))
  const scoreByKey = new Map<string, SwebenchScores['results'][number]>()
  for (const result of scores.results) {
    const key = `${result.armId}/${result.instanceId}`
    if (!plannedKeys.has(key)) throw new Error(`score outside the planned trials: ${key}`)
    if (scoreByKey.has(key)) throw new Error(`duplicate score: ${key}`)
    scoreByKey.set(key, result)
  }
  const records: TrialRecord[] = runs.map(run => {
    const base = { taskId: run.instanceId, arm: run.armId, repeat: 1 }
    const score = scoreByKey.get(`${run.armId}/${run.instanceId}`)
    if (run.status === 'infrastructure' && score?.resolved !== true) return { ...base, verdict: 'unknown', reason: 'infrastructure' }
    if (!score) return { ...base, verdict: 'unknown', reason: 'missing_evidence' }
    if (score.classification === 'error') return { ...base, verdict: 'unknown', reason: 'grader_error' }
    return { ...base, verdict: score.resolved ? 'pass' : 'fail' }
  })
  return { planned, records }
}

// --- 编排四臂：计划取自 assembleRunMatrix 的 RunSpec，记录兼容原始 RunResult 与公开样例 ---
export interface OrchestrationRunLike {
  runId: string
  status: string
  hiddenPassed?: boolean
  hidden?: { passed?: boolean; results?: readonly { exitCode: number | null }[] } | Record<string, boolean>
}

export const orchestrationPlanned = (specs: readonly { taskId: string; arm: string; repeat: number }[]): PlannedTrial[] =>
  specs.map(spec => ({ taskId: spec.taskId, arm: spec.arm, repeat: spec.repeat }))

export function parseRunId(runId: string): PlannedTrial {
  const parts = runId.split(':')
  const repeat = Number(parts[2])
  if (parts.length !== 3 || !parts[0] || !parts[1] || !Number.isSafeInteger(repeat)) throw new Error(`runId must be task:arm:repeat: ${runId}`)
  return { taskId: parts[0], arm: parts[1], repeat }
}

export function orchestrationRecords(runs: readonly OrchestrationRunLike[]): TrialRecord[] {
  return runs.map(run => {
    const base = parseRunId(run.runId)
    if (run.status === 'infrastructure_error') return { ...base, verdict: 'unknown', reason: 'infrastructure' }
    const results = typeof run.hidden?.results === 'object' && Array.isArray(run.hidden.results) ? run.hidden.results as readonly { exitCode: number | null }[] : []
    if (results.some(result => result.exitCode === null)) return { ...base, verdict: 'unknown', reason: 'grader_error' }
    const passed = typeof run.hiddenPassed === 'boolean' ? run.hiddenPassed : typeof run.hidden?.passed === 'boolean' ? run.hidden.passed : undefined
    if (passed === undefined) return { ...base, verdict: 'unknown', reason: 'missing_evidence' }
    return { ...base, verdict: passed ? 'pass' : 'fail' }
  })
}
