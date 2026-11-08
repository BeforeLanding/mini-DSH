import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PlanInput, SubtaskSpec } from '../src/orchestration/contracts.js'
import { DEFAULT_PROTECTED_PATHS, validatePlan } from '../src/orchestration/plan.js'

// 多 Agent 编排的组合夹具（DEVELOPMENT.md §14.3）。它把现有 coding fixture 的**参考解与验收器**
// 搬进同一个仓库的不同子目录，从而给「并行写入者 + 宿主整合」一个真实形状。
//
// 两套验收职责分开，理由见 DECISIONS 的 M4-①：
// - `check`：工作区里的**冒烟检查**（每个包一个例子），作为计划里的验收命令。宿主的命令闸门只接受
//   工作区内相对路径，因此隐藏验收器不能在验收命令里被引用。
// - `verify`：工作区之外的隐藏验收器，覆盖更多边界输入；演示与评测在整合结果上独立运行它，
//   并以它的读数作为最终验收结论。它不在任何 plan/日志里，worker 无从读取。
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))
const coding = path.join(repositoryRoot, 'test', 'fixtures', 'coding')
const orchestration = path.join(repositoryRoot, 'test', 'fixtures', 'orchestration')
export const fixtureProcessTimeoutMs = 30_000

export type OrchestrationFixtureId = 'parallel-composite' | 'single-repair'

interface HiddenVerify { script: string; target: string; marker: string }
interface FixtureTask {
  id: string
  title: string
  objective: string
  writeSet: string[]
  dependsOn?: string[]
  // 工作区内、计划验收命令使用的冒烟检查。
  check: string
  verify: HiddenVerify
}
export interface OrchestrationFixtureDefinition {
  id: OrchestrationFixtureId
  goal: string
  rationale: string
  tasks: FixtureTask[]
}

const codingVerify = (id: string, target: string): HiddenVerify => ({
  script: path.join(coding, id, 'verify.mjs'), target, marker: `acceptance passed: ${id}`,
})
const reportVerify: HiddenVerify = {
  script: path.join(orchestration, 'parallel-composite', 'verify', 'report.mjs'),
  target: 'packages/report', marker: 'acceptance passed: report',
}

export const orchestrationFixtureIds: readonly OrchestrationFixtureId[] = ['parallel-composite', 'single-repair']
export const orchestrationFixtures: Readonly<Record<OrchestrationFixtureId, OrchestrationFixtureDefinition>> = Object.freeze({
  'parallel-composite': {
    id: 'parallel-composite',
    goal: 'Fix the normalize and dedupe packages, then add a report package that combines both through their public exports.',
    rationale: 'normalize and dedupe are independent files; report consumes both and therefore belongs to the second wave',
    tasks: [
      {
        id: 'st-1', title: 'fix normalizeName',
        objective: 'In packages/normalize, fix normalizeName in src/name.mjs: trim the input, collapse every internal whitespace run to one space, and lowercase the result. Do not modify other files.',
        writeSet: ['packages/normalize/src/name.mjs'], check: 'node packages/normalize/check.mjs', verify: codingVerify('normalize', 'packages/normalize'),
      },
      {
        id: 'st-2', title: 'fix uniqueById',
        objective: 'In packages/dedupe, fix uniqueById in src/unique.mjs: keep the first item for every id and discard later items with the same id. Do not modify other files.',
        writeSet: ['packages/dedupe/src/unique.mjs'], check: 'node packages/dedupe/check.mjs', verify: codingVerify('dedupe', 'packages/dedupe'),
      },
      {
        id: 'st-3', title: 'add describePeople',
        objective: 'Create packages/report/src/report.mjs exporting describePeople(people). Import normalizeName from ../../normalize/src/name.mjs and uniqueById from ../../dedupe/src/unique.mjs. Return { names: people.map(person => normalizeName(person.name)), count: uniqueById(people).length }. Do not modify the other packages.',
        writeSet: ['packages/report/src/report.mjs'], dependsOn: ['st-1', 'st-2'], check: 'node packages/report/check.mjs', verify: reportVerify,
      },
    ],
  },
  'single-repair': {
    id: 'single-repair',
    goal: 'Fix the cart total in this repository. Per-item discounts and whole-order percentage discounts are both wrong; follow the project rules before editing.',
    rationale: 'one root cause in one file; splitting it would duplicate context without independent verification',
    tasks: [{
      id: 'st-1', title: 'fix the cart total',
      objective: 'Read AGENTS.md and src/AGENTS.md first. Fix src/cart.mjs so subtotal applies per-item discounts, discount rounds the percentage result to cents, and total composes both. Do not modify other files.',
      writeSet: ['src/cart.mjs'], check: 'node check.mjs', verify: codingVerify('repair', '.'),
    }],
  },
})

export function fixturePlan(id: OrchestrationFixtureId): PlanInput {
  const fixture = orchestrationFixtures[id]
  return {
    version: 1,
    rationale: fixture.rationale,
    subtasks: fixture.tasks.map((task): SubtaskSpec => ({
      id: task.id, title: task.title, objective: task.objective, writeSet: [...task.writeSet],
      ...(task.dependsOn ? { dependsOn: [...task.dependsOn] } : {}),
      acceptance: { commands: [task.check] },
    })),
  }
}

async function copy(source: string, target: string) {
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.copyFile(source, target)
}
async function copyInitialPackage(id: string, destination: string, files: readonly string[], extra: readonly string[] = []) {
  for (const file of [...files, ...extra]) await copy(path.join(coding, id, 'initial', file), path.join(destination, file))
}
async function copyReference(id: string, destination: string, files: readonly string[]) {
  for (const file of files) await copy(path.join(coding, id, 'reference', file), path.join(destination, file))
}

// `reference` 只覆盖参考解，用来证明验收器接受正确实现；它**不**进入初始工作区。
export async function materializeOrchestrationFixture(id: OrchestrationFixtureId, directory: string, { reference = false } = {}) {
  if (!orchestrationFixtureIds.includes(id)) throw new Error(`unknown orchestration fixture: ${id}`)
  if (id === 'parallel-composite') {
    await copyInitialPackage('normalize', path.join(directory, 'packages/normalize'), ['package.json', 'src/name.mjs', 'check.mjs'])
    await copyInitialPackage('dedupe', path.join(directory, 'packages/dedupe'), ['package.json', 'src/unique.mjs', 'check.mjs'])
    await fs.cp(path.join(orchestration, 'parallel-composite', 'initial'), directory, { recursive: true })
    if (reference) {
      await copyReference('normalize', path.join(directory, 'packages/normalize'), ['src/name.mjs'])
      await copyReference('dedupe', path.join(directory, 'packages/dedupe'), ['src/unique.mjs'])
      await copy(path.join(orchestration, 'parallel-composite', 'reference', 'packages/report/src/report.mjs'), path.join(directory, 'packages/report/src/report.mjs'))
    }
  } else {
    await fs.cp(path.join(coding, 'repair', 'initial'), directory, { recursive: true })
    if (reference) await copyReference('repair', directory, ['src/cart.mjs'])
  }
  return directory
}

export interface VerifyResult { taskId: string; command: string; exitCode: number | null; output: string; passed: boolean }
// 逐任务运行隐藏验收器。初始态至少一个失败、参考态全部通过，是这组夹具的正反例。
export async function evaluateOrchestrationFixture(id: OrchestrationFixtureId, workspace: string, { timeoutMs = fixtureProcessTimeoutMs } = {}) {
  const results: VerifyResult[] = []
  for (const task of orchestrationFixtures[id].tasks) {
    const [script, target] = [task.verify.script, task.verify.target]
    const result = spawnSync(process.execPath, [script, target], {
      cwd: workspace, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024, windowsHide: true,
    })
    const output = Buffer.from([result.error?.message, result.stdout, result.stderr].filter(Boolean).join('\n')).subarray(0, 32 * 1024).toString('utf8').trim()
    results.push({ taskId: task.id, command: `${path.relative(repositoryRoot, script)} ${target}`, exitCode: result.status, output, passed: result.status === 0 && !result.error && output === task.verify.marker })
  }
  return { passed: results.every(result => result.passed), results }
}

export interface FixtureValidation {
  id: OrchestrationFixtureId
  initialRejected: boolean
  referenceAccepted: boolean
  mode: 'single' | 'parallel'
  waves: string[][]
  commands: string[]
  readings: string[]
}
// 零付费校验：只读写文件与运行隐藏验收器，不装配任何模型适配器。
export async function validateOrchestrationFixture(id: OrchestrationFixtureId): Promise<FixtureValidation> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `mini-dsh-orch-fixture-${id}-`))
  try {
    const initial = path.join(directory, 'initial')
    await materializeOrchestrationFixture(id, initial)
    const initialResult = await evaluateOrchestrationFixture(id, initial)
    const reference = path.join(directory, 'reference')
    await materializeOrchestrationFixture(id, reference, { reference: true })
    const referenceResult = await evaluateOrchestrationFixture(id, reference)
    const plan = fixturePlan(id)
    const validation = validatePlan(plan, { workspace: reference, maxSubtasks: 6, protectedPaths: DEFAULT_PROTECTED_PATHS })
    if (!validation.ok) throw new Error(`fixture ${id} plan is invalid: ${validation.errors.join('; ')}`)
    return {
      id,
      initialRejected: !initialResult.passed && initialResult.results.some(result => result.exitCode !== 0),
      referenceAccepted: referenceResult.passed,
      mode: validation.decision.mode,
      waves: validation.decision.waves,
      commands: plan.subtasks.flatMap(subtask => subtask.acceptance.commands),
      readings: [initialResult, referenceResult].flatMap(result => result.results.map(item => `${item.taskId}: exit=${item.exitCode}`)),
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}
