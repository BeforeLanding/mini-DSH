import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  evaluateOrchestrationFixture, fixtureProcessTimeoutMs, orchestrationFixtureIds, orchestrationFixtures,
  type FixtureTask, type OrchestrationFixtureId,
} from './orchestration-fixtures.js'

// 历史重评分（ET-3）：把旧产物复制到临时目录，用**当前版本**的隐藏验收器重新评分，写出一条新的 grade 记录。
// 它只验证“grader 对旧产物的判决是否符合预期”，不证明新版 Agent 不再犯同样的错；全程不调用任何模型。
// 原始样本与 case.json 只读，不覆盖。
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))
export const regradeRoot = path.join(repositoryRoot, 'test', 'fixtures', 'regrade')

// unknown 的三种原因：缺少验收目标文件、样本与当前 grader 契约不匹配、验收器无法启动/超时。
export type RegradeUnknownReason = 'missing_evidence' | 'incompatible' | 'grader_error'
export interface RegradeExpected { verdict: 'pass' | 'fail'; failedTasks: string[] }
export interface RegradeCase {
  schemaVersion: 1
  kind: 'regrade-case'
  fixture: string
  validates: 'grader'
  source: { batch: string; runId: string; runJsonSha256: string; [key: string]: unknown }
  files: Record<string, string>
  expected: RegradeExpected
  annotation: string
}
export type RegradeGrade = {
  schemaVersion: 1
  kind: 'regrade-grade'
  caseId: string
  fixture: string
  runId: string
  sampleSha256: string
  graderSha256: Record<string, string | null>
  tasks: { taskId: string; passed: boolean; exitCode: number | null }[]
  failedTasks: string[]
  annotation: string
  detail?: string
} & ({ verdict: 'pass' | 'fail'; reason?: undefined } | { verdict: 'unknown'; reason: RegradeUnknownReason })

const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex')
// node:assert 失败会在输出里留下 AssertionError / ERR_ASSERTION；验收器的有效“失败”判决必须是它。
const assertionFailure = /AssertionError|ERR_ASSERTION/
const firstLine = (text: string) => text.split(String.fromCharCode(10)).find(line => line.trim())?.trim().slice(0, 160) ?? 'no output'
const exists = (target: string) => fs.stat(target).then(() => true, () => false)

export interface RegradeOptions { tasks?: readonly FixtureTask[]; timeoutMs?: number }

export async function regradeCase(caseDirectory: string, options: RegradeOptions = {}): Promise<RegradeGrade> {
  const caseId = path.basename(caseDirectory)
  const blank = { schemaVersion: 1 as const, kind: 'regrade-grade' as const, caseId, fixture: '', runId: '', sampleSha256: '', graderSha256: {}, tasks: [], failedTasks: [], annotation: '' }
  const unknown = (reason: RegradeUnknownReason, detail: string, extra: Partial<RegradeGrade> = {}): RegradeGrade => ({ ...blank, ...extra, verdict: 'unknown', reason, detail }) as RegradeGrade

  let spec: RegradeCase
  try {
    spec = JSON.parse(await fs.readFile(path.join(caseDirectory, 'case.json'), 'utf8')) as RegradeCase
  } catch (error) {
    return unknown('incompatible', `case.json is unreadable: ${error instanceof Error ? error.message : String(error)}`)
  }
  const identity = { fixture: String(spec.fixture), runId: String(spec.source?.runId ?? ''), annotation: String(spec.annotation ?? '') }
  if (spec.kind !== 'regrade-case' || spec.schemaVersion !== 1 || spec.validates !== 'grader' || typeof spec.files !== 'object' || !spec.files) {
    return unknown('incompatible', 'case.json does not follow regrade-case schema v1', identity)
  }
  if (!orchestrationFixtureIds.includes(spec.fixture as OrchestrationFixtureId)) {
    return unknown('incompatible', `fixture ${spec.fixture} is not an orchestration fixture known to the current grader`, identity)
  }
  const id = spec.fixture as OrchestrationFixtureId
  const tasks = options.tasks ?? orchestrationFixtures[id].tasks

  const sample = path.join(caseDirectory, 'sample')
  if (!(await exists(sample))) return unknown('missing_evidence', 'sample/ directory is missing', identity)
  const digests: string[] = []
  for (const [relative, expected] of Object.entries(spec.files).sort(([a], [b]) => a.localeCompare(b))) {
    const file = path.join(sample, ...relative.split('/'))
    if (!(await exists(file))) return unknown('missing_evidence', `sample file is missing: ${relative}`, identity)
    const actual = sha256(await fs.readFile(file))
    if (actual !== expected) return unknown('incompatible', `sample file changed since the case was recorded: ${relative}`, identity)
    digests.push(`${relative} ${actual}`)
  }
  const sampleSha256 = sha256(digests.join('\n'))
  const withSample = { ...identity, sampleSha256 }

  const graderSha256: Record<string, string | null> = {}
  for (const task of tasks) {
    const relative = path.relative(repositoryRoot, task.verify.script).split(path.sep).join('/')
    graderSha256[relative] = await fs.readFile(task.verify.script).then(sha256, () => null)
  }
  const missingGrader = Object.entries(graderSha256).find(([, digest]) => digest === null)
  if (missingGrader) return unknown('grader_error', `grader script does not exist: ${missingGrader[0]}`, { ...withSample, graderSha256 })
  const withGrader = { ...withSample, graderSha256 }

  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-regrade-'))
  try {
    await fs.cp(sample, workspace, { recursive: true })
    for (const task of tasks) {
      if (!(await exists(path.join(workspace, task.verify.target, 'src')))) return unknown('missing_evidence', `acceptance target is missing: ${task.verify.target}/src`, withGrader)
    }
    const evaluation = await evaluateOrchestrationFixture(id, workspace, { timeoutMs: options.timeoutMs ?? fixtureProcessTimeoutMs, tasks })
    const results = evaluation.results.map(result => ({ taskId: result.taskId, passed: result.passed, exitCode: result.exitCode }))
    const failedTasks = results.filter(result => !result.passed).map(result => result.taskId)
    const base = { ...blank, ...withGrader, tasks: results, failedTasks }
    // 只有“通过”（退出码 0 且输出约定的标记）或“断言失败”（非零退出且输出含 AssertionError）才是有效判决；
    // 其余——无法启动、超时、语法错误、未捕获异常、依赖错误、退出 0 却没有标记——都不是对产物的判决，
    // 不能算任务失败，否则损坏的验收器会让“预期失败”的回归检查错误变绿。
    const invalid = evaluation.results.flatMap((result, index) => {
      const marker = tasks[index]!.verify.marker
      const valid = result.passed || (result.exitCode !== null && result.exitCode !== 0 && assertionFailure.test(result.output))
      return valid ? [] : [`${result.taskId} (exit ${result.exitCode === null ? 'none' : result.exitCode}${result.exitCode === 0 ? `, no "${marker}" marker` : ''}): ${firstLine(result.output)}`]
    })
    if (invalid.length) return { ...base, verdict: 'unknown', reason: 'grader_error', detail: `grader produced no valid verdict for ${invalid.join('; ')}` }
    return { ...base, verdict: failedTasks.length ? 'fail' : 'pass' }
  } finally {
    await fs.rm(workspace, { recursive: true, force: true })
  }
}

// CI 的判据：实际判决等于预期判决（fail 还要失败任务一致）；判出 unknown 视为未通过。
export function checkRegrade(grade: RegradeGrade, expected: RegradeExpected): { passed: boolean; reason: string } {
  if (grade.verdict === 'unknown') return { passed: false, reason: `unknown (${grade.reason}): ${grade.detail ?? ''}` }
  if (grade.verdict !== expected.verdict) return { passed: false, reason: `expected ${expected.verdict}, got ${grade.verdict}` }
  if (JSON.stringify(grade.failedTasks) !== JSON.stringify(expected.failedTasks)) {
    return { passed: false, reason: `expected failed tasks [${expected.failedTasks}], got [${grade.failedTasks}]` }
  }
  return { passed: true, reason: 'verdict matches the expectation' }
}

export async function regradeAll(root = regradeRoot) {
  const entries = (await fs.readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
  const outcomes = []
  for (const name of entries) {
    const directory = path.join(root, name)
    const spec = JSON.parse(await fs.readFile(path.join(directory, 'case.json'), 'utf8').catch(() => '{}')) as Partial<RegradeCase>
    const grade = await regradeCase(directory)
    const check = spec.expected ? checkRegrade(grade, spec.expected) : { passed: false, reason: 'case.json has no expected verdict' }
    outcomes.push({ case: name, grade, ...check })
  }
  return outcomes
}

async function cli() {
  const outIndex = process.argv.indexOf('--out')
  const outcomes = await regradeAll()
  if (outIndex >= 0 && process.argv[outIndex + 1]) await fs.writeFile(process.argv[outIndex + 1]!, `${JSON.stringify(outcomes.map(outcome => outcome.grade), null, 2)}\n`)
  for (const outcome of outcomes) {
    const detail = [outcome.grade.verdict + (outcome.grade.reason ? `/${outcome.grade.reason}` : ''), outcome.grade.failedTasks.length ? `failed ${outcome.grade.failedTasks.join(',')}` : ''].filter(Boolean).join(', ')
    console.log(`${outcome.passed ? 'PASS' : 'FAIL'} ${outcome.case}: ${outcome.reason} [grade ${detail}]`)
  }
  console.log('regrade validates the grader against historical artifacts; it does not show that a newer agent avoids the same mistake. Model requests: 0')
  if (!outcomes.length || outcomes.some(outcome => !outcome.passed)) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void cli().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
