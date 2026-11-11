import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { regradeAll, regradeRoot } from './eval-regrade.js'
import type { RegradeGrade } from './eval-regrade.js'
import { orchestrationRecords, parseRunId, summarizeTrials, trialKey } from './eval-trials.js'
import type { ArmTrials, OrchestrationRunLike, PlannedTrial } from './eval-trials.js'

// 零付费的端到端报告：从一个历史证据目录（冻结 manifest + 原始 run 记录）出发，重算交付率、可评分成功率和覆盖，
// 与原报告、公开样例交叉核对，并附上历史重评分。只读证据目录，不调用任何模型。
// 它不是“编排是否更好”的结论：该批 S/D 与 R 存在规格不对称，且 R/R-serial 用固定计划。
const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex')

export interface ReportCheck { name: string; passed: boolean; detail: string }
export interface OrchestrationReport {
  schemaVersion: 1
  kind: 'orchestration-trials-report'
  evidence: { directory: string; protocol: string; gitCommit: string; matrixDigest: string; manifestSha256: string; reportSha256: string | null }
  plannedRuns: number
  executedRuns: number
  arms: ArmTrials[]
  regrade: { case: string; passed: boolean; reason: string; grade: RegradeGrade }[]
  caveats: string[]
  scope: string
  checks: ReportCheck[]
  passed: boolean
}

interface Manifest { protocol: string; gitCommit: string; matrixDigest: string; arms: string[]; tasks: string[]; repeats: number; runOrder: string[] }
interface OriginalReport { plannedRuns?: number; executedRuns?: number; summary?: { byArm?: Record<string, { runs: number; hiddenPassed: number }> } }
interface PublicSample { manifestSha256?: string; reportSha256?: string; byArm?: Record<string, { runs: number; hiddenPassed: number }> }

export interface ReportOptions { publicSample?: string; regradeDirectory?: string }

const readJson = async <T>(file: string, label: string): Promise<{ value: T; sha256: string }> => {
  let raw: Buffer
  try { raw = await fs.readFile(file) } catch (error) { throw new Error(`${label} is unreadable: ${error instanceof Error ? error.message : String(error)}`) }
  try { return { value: JSON.parse(raw.toString('utf8')) as T, sha256: sha256(raw) } } catch { throw new Error(`${label} is not valid JSON`) }
}

export async function buildOrchestrationReport(evidenceRoot: string, options: ReportOptions = {}): Promise<OrchestrationReport> {
  const manifestFile = await readJson<Manifest>(path.join(evidenceRoot, 'manifest.json'), 'manifest.json')
  const manifest = manifestFile.value
  if (!Array.isArray(manifest.runOrder) || !Array.isArray(manifest.arms) || !Array.isArray(manifest.tasks)) throw new Error('manifest.json lacks runOrder/arms/tasks')
  const checks: ReportCheck[] = []
  const check = (name: string, passed: boolean, detail: string) => checks.push({ name, passed, detail })

  // 历史计划来自历史 manifest 的 runOrder，而不是今天的 assembleRunMatrix。
  const planned: PlannedTrial[] = manifest.runOrder.map(parseRunId)
  const expectedKeys = manifest.tasks.flatMap(task => manifest.arms.flatMap(arm => Array.from({ length: manifest.repeats }, (_, index) => `${task}:${arm}:${index + 1}`)))
  const plannedKeys = planned.map(trialKey)
  const consistent = plannedKeys.length === expectedKeys.length && new Set(plannedKeys).size === plannedKeys.length && expectedKeys.every(key => plannedKeys.includes(key))
  check('manifest-plan-consistent', consistent, consistent ? `${planned.length} planned runs = tasks x arms x repeats` : 'manifest.runOrder does not match tasks x arms x repeats')

  const originalFile = await readJson<OriginalReport>(path.join(evidenceRoot, 'report.json'), 'report.json').catch(() => null)
  const runsDirectory = path.join(evidenceRoot, 'runs')
  const runDirectories = (await fs.readdir(runsDirectory, { withFileTypes: true }).catch(() => [])).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
  const runs: OrchestrationRunLike[] = []
  const unreadable: string[] = []
  for (const name of runDirectories) {
    try { runs.push((await readJson<OrchestrationRunLike>(path.join(runsDirectory, name, 'run.json'), `${name}/run.json`)).value) } catch (error) { unreadable.push(error instanceof Error ? error.message : String(error)) }
  }
  check('run-records-readable', unreadable.length === 0, unreadable.length ? unreadable.join('; ') : `${runs.length} run.json files read`)

  let arms: ArmTrials[] = []
  try {
    arms = summarizeTrials(planned, orchestrationRecords(runs))
    check('trials-summarised', true, 'no duplicate, out-of-plan or malformed run records')
  } catch (error) {
    check('trials-summarised', false, error instanceof Error ? error.message : String(error))
  }
  const unclean = arms.flatMap(arm => {
    const { notExecuted, infrastructure, grader_error, missing_evidence } = arm.coverage
    return notExecuted + infrastructure + grader_error + missing_evidence > 0
      ? [`${arm.arm}: not executed ${notExecuted}, infrastructure ${infrastructure}, grader_error ${grader_error}, missing_evidence ${missing_evidence}`] : []
  })
  if (arms.length) check('every-trial-has-a-verdict', unclean.length === 0, unclean.length ? unclean.join('; ') : 'every planned trial is pass or fail')

  const sameByArm = (reference: Record<string, { runs: number; hiddenPassed: number }> | undefined, label: string) => {
    if (!reference) return check(label, false, 'reference has no byArm summary')
    const mismatches = arms.flatMap(arm => {
      const expected = reference[arm.arm]
      const actual = `${arm.delivery.passed}/${arm.delivery.denominator}`
      return expected && `${expected.hiddenPassed}/${expected.runs}` === actual ? [] : [`${arm.arm}: recomputed ${actual}, reference ${expected ? `${expected.hiddenPassed}/${expected.runs}` : 'missing'}`]
    })
    check(label, arms.length > 0 && mismatches.length === 0, mismatches.length ? mismatches.join('; ') : 'per-arm passed/planned equals the reference')
  }
  if (originalFile) {
    const original = originalFile.value
    const countsOk = original.plannedRuns === planned.length && original.executedRuns === runs.length
    check('original-report-counts', countsOk, `report.json plannedRuns=${original.plannedRuns} executedRuns=${original.executedRuns}; manifest plans ${planned.length}, ${runs.length} run records found`)
    sameByArm(original.summary?.byArm, 'original-report-by-arm')
  } else check('original-report-present', false, 'report.json is missing or unreadable')

  if (options.publicSample) {
    const sample = (await readJson<PublicSample>(options.publicSample, 'public sample')).value
    check('public-sample-manifest-sha256', sample.manifestSha256 === manifestFile.sha256, `manifest ${manifestFile.sha256}, sample ${sample.manifestSha256 ?? 'missing'}`)
    check('public-sample-report-sha256', !!originalFile && sample.reportSha256 === originalFile.sha256, `report ${originalFile?.sha256 ?? 'missing'}, sample ${sample.reportSha256 ?? 'missing'}`)
    sameByArm(sample.byArm, 'public-sample-by-arm')
  }

  // 历史重评分是独立记录：只验证 grader 对旧产物的判决，样本与证据目录都不被改动。
  const regradeOutcomes = await regradeAll(options.regradeDirectory ?? regradeRoot)
  const inPlan = regradeOutcomes.filter(outcome => plannedKeys.includes(outcome.grade.runId))
  check('regrade-cases-for-this-batch', inPlan.length > 0, inPlan.length ? `${inPlan.length} regrade case(s) belong to this batch` : 'no regrade case matches a planned run')
  check('regrade-matches-expectation', inPlan.length > 0 && inPlan.every(outcome => outcome.passed), inPlan.map(outcome => `${outcome.case}: ${outcome.reason}`).join('; ') || 'nothing to regrade')

  const ungradable = regradeOutcomes.filter(outcome => outcome.grade.verdict === 'unknown')
  check('regrade-has-no-unknown', ungradable.length === 0, ungradable.length ? ungradable.map(outcome => `${outcome.case}: ${outcome.reason}`).join('; ') : 'every regrade case produced a pass or fail verdict')

  const caveats = [...new Set(inPlan.map(outcome => outcome.grade.annotation).filter(Boolean))]
  if (caveats.some(text => text.includes('spec-asymmetry'))) caveats.push('S/D and R received unequal specifications in this batch, so their pass rates must not be compared as capability.')
  caveats.push('R and R-serial ran a fixed plan: conclusions are limited to orchestrated execution of a given plan.')

  return {
    schemaVersion: 1,
    kind: 'orchestration-trials-report',
    evidence: { directory: path.basename(path.resolve(evidenceRoot)), protocol: manifest.protocol, gitCommit: manifest.gitCommit, matrixDigest: manifest.matrixDigest, manifestSha256: manifestFile.sha256, reportSha256: originalFile?.sha256 ?? null },
    plannedRuns: planned.length,
    executedRuns: runs.length,
    arms,
    regrade: inPlan.map(outcome => ({ case: outcome.case, passed: outcome.passed, reason: outcome.reason, grade: outcome.grade })),
    caveats,
    scope: 'Recomputes denominators from a frozen manifest and raw run records and regrades a historical artifact with the current grader. It shows the grader still judges the old artifact as expected; it does not show that a newer agent avoids the mistake. Model requests: 0.',
    checks,
    passed: checks.every(item => item.passed),
  }
}

export function formatReport(report: OrchestrationReport) {
  const percent = (value: number | null) => (value === null ? 'n/a' : `${(value * 100).toFixed(0)}%`)
  const interval = (ratio: ArmTrials['delivery']) => `${percent(ratio.rate)} [${(ratio.wilson95.low * 100).toFixed(0)}-${(ratio.wilson95.high * 100).toFixed(0)}%]`
  const lines = [`evidence ${report.evidence.directory} (${report.evidence.protocol}, manifest sha256 ${report.evidence.manifestSha256.slice(0, 12)}, planned ${report.plannedRuns}, run records ${report.executedRuns})`]
  for (const arm of report.arms) {
    lines.push(`  ${arm.arm.padEnd(9)} delivery ${arm.delivery.passed}/${arm.delivery.denominator} ${interval(arm.delivery)}  gradable ${arm.gradable.passed}/${arm.gradable.denominator} ${interval(arm.gradable)}  `
      + `not executed ${arm.coverage.notExecuted}, unknown: infrastructure ${arm.coverage.infrastructure}, grader_error ${arm.coverage.grader_error}, missing_evidence ${arm.coverage.missing_evidence}`)
  }
  for (const item of report.regrade) lines.push(`  regrade ${item.case}: grade ${item.grade.verdict}${item.grade.failedTasks.length ? ` (${item.grade.failedTasks.join(',')})` : ''}, ${item.passed ? 'matches expectation' : `MISMATCH ${item.reason}`}`)
  for (const item of report.checks) lines.push(`  ${item.passed ? 'ok  ' : 'FAIL'} ${item.name}: ${item.detail}`)
  for (const text of report.caveats) lines.push(`  caveat: ${text}`)
  lines.push(`  ${report.scope}`, report.passed ? 'RESULT: PASS' : 'RESULT: FAIL')
  return lines.join(String.fromCharCode(10))
}

const argument = (name: string) => {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

async function cli() {
  const root = argument('--evidence-root')
  if (!root) throw new Error('usage: eval-orchestration-report --evidence-root <batch directory> [--public-sample <json>] [--out <new file>]')
  const publicSample = argument('--public-sample')
  const out = argument('--out')
  const report = await buildOrchestrationReport(path.resolve(root), publicSample ? { publicSample: path.resolve(publicSample) } : {})
  console.log(formatReport(report))
  // 新报告是独立记录：只写到一个新文件，不覆盖任何已有文件，也不写进证据目录。
  if (out) await fs.writeFile(path.resolve(out), `${JSON.stringify(report, null, 2)}${String.fromCharCode(10)}`, { flag: 'wx' })
  if (!report.passed) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void cli().catch(error => { console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1 })
