import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

// 筛查批次固定为这 12 个单任务 fixture：NX-08d 的 12/12 历史结论与 phaseCaps.screening 的上限都以它为准，
// 新增 fixture 不应改变这个批次，否则旧结论与旧上限都不再对应同一个任务集。
export const screeningIds = ['boundary', 'options', 'interface', 'normalize', 'dedupe', 'pagination', 'query', 'retry', 'merge', 'csv', 'inventory', 'summary'] as const
// 对照 A 的仪器：同一会话内按序下发的多阶段任务序列（TASKS/*.md），后阶段依赖前阶段产物。
export const sequenceIds = ['pipeline'] as const
// 对照 B 的仪器：单任务 fixture，靠一条会产生大量 stdout 的受保护命令把「工具输出是否有界」变成可观察量。
// 它不进筛查批次（那 12 个单任务 fixture 已冻结）也不进阶段序列（要的是单任务会话），因此单独一份注册表。
export const boundedIds = ['audit'] as const
// NX-10 的演示夹具：唯一一个**带项目规则**（`AGENTS.md`）的 fixture，供 `pnpm demo:*` 展示
// 「项目规则 → 定位 → 修改 → 失败测试 → 再修复 → diff 与证据」。它不进筛查批次（那 12 个已冻结、
// 且加入会让 `phaseCaps.screening.runs` 与 12/12 的历史基线不再对应），也不进阶段序列与对照 B 仪器
// （两者的契约都是「单任务」或「多阶段」，与演示无关），因此单独一份注册表。
export const demoIds = ['repair'] as const
// NX-08h 的仪器：`pipeline` 十四阶段的复制，但工作区里**没有公开的 `check.mjs`**——任务说明不再给出
// 这个命令，只能按 `docs/SPEC.md` 自验。它测的是「能否按规格独立产出正确实现」，而 `pipeline` 测的是
// 「有完整、即时、廉价 oracle 时能否收敛」；NX-08g0 判定的天花板效应正来自后者的 oracle。
// 它不进 sequenceIds：`phaseCaps.sequence.runs = 1` 而 registry 会有 2 项，`repeatCount(1, 2)` 直接抛
// 「cannot be split evenly」；即便整除，也会让对照 A 的两臂拿到不同的任务集，把「上下文策略」换成
// 「任务难度」。因此单独一份注册表。
export const blindIds = ['blind'] as const
export const fixtureIds = [...screeningIds, ...sequenceIds, ...boundedIds, ...demoIds, ...blindIds] as const
export type FixtureId = typeof fixtureIds[number]
const repository = fileURLToPath(new URL('../../', import.meta.url))
const fixtures = path.join(repository, 'test', 'fixtures', 'coding')
// Cold-starting a Node process inside a freshly created temp workspace costs far more on
// Windows CI than the work itself: the same merge verification measured 120ms on Ubuntu
// but exceeded a 10s budget on windows-latest/Node22, while the next test on that machine
// finished a heavier flow in 1s. This budget bounds a hung candidate, not a performance
// target, so it keeps headroom for a cold start rather than tracking typical latency.
export const fixtureProcessTimeoutMs = 30_000
const sources: Record<FixtureId, string[]> = {
  boundary: ['src/index.mjs'], options: ['src/join.mjs'], interface: ['src/pricing.mjs', 'src/receipt.mjs'], summary: ['src/summary.mjs'], inventory: ['src/order.mjs', 'src/receipt.mjs'], csv: ['src/csv.mjs'], merge: ['src/merge.mjs', 'src/value.mjs'], retry: ['src/retry.mjs'], query: ['src/query.mjs'], pagination: ['src/page.mjs'], dedupe: ['src/unique.mjs'], normalize: ['src/name.mjs'],
  pipeline: ['src/parse.mjs', 'src/order.mjs', 'src/cycles.mjs', 'src/batches.mjs', 'src/report.mjs', 'src/delta.mjs', 'src/plan-parse.mjs', 'src/plan-merge.mjs', 'src/blocked.mjs', 'src/audit.mjs', 'src/parse-audit.mjs', 'src/closure.mjs', 'src/sub-plan.mjs', 'src/audit-delta.mjs', 'src/pipeline.mjs'],
  audit: ['src/normalize.mjs', 'src/audit.mjs'],
  // repair 是演示夹具里唯一可改的文件；两份 AGENTS.md、check.mjs、package.json、src/legacy/ 与
  // src/pricing.mjs 都不在这里，因而全部进受保护集合。
  repair: ['src/cart.mjs'],
  // blind 与 pipeline 的可改文件逐字相同：唯一的差异是 initial/ 下没有 check.mjs，因此 docs/SPEC.md 与
  // data/ 成了工作区里唯一的规范载体，也更有动机被改动——它们照旧落在受保护集合里。
  blind: ['src/parse.mjs', 'src/order.mjs', 'src/cycles.mjs', 'src/batches.mjs', 'src/report.mjs', 'src/delta.mjs', 'src/plan-parse.mjs', 'src/plan-merge.mjs', 'src/blocked.mjs', 'src/audit.mjs', 'src/parse-audit.mjs', 'src/closure.mjs', 'src/sub-plan.mjs', 'src/audit-delta.mjs', 'src/pipeline.mjs'],
}
async function exists(target: string): Promise<boolean> { return fs.stat(target).then(() => true, () => false) }
// 一个 fixture 要么是单个任务（TASK.md），要么是同一会话内按序下发的多个阶段（TASKS/*.md，按文件名
// 排序，所以承载顺序的是 01-/02- 这类前缀）。两种布局互斥：若同时接受，读到哪一份就决定了模型被要求
// 做多少，而读者很难察觉——这正是「任务做大一点就能触发裁剪」那条错误判据的同一类陷阱。
// 阶段序列是上下文对照的前提：裁剪只移除同一会话中更早结束的任务，单任务会话无论多大都不会触发。
export async function readTaskSequence(source: string): Promise<string[]> {
  const directory = path.join(source, 'TASKS')
  if (!(await exists(directory))) return [await fs.readFile(path.join(source, 'TASK.md'), 'utf8')]
  if (await exists(path.join(source, 'TASK.md'))) throw new Error('fixture has both TASK.md and TASKS/')
  const stages = (await fs.readdir(directory)).filter(name => name.endsWith('.md')).sort()
  if (!stages.length) throw new Error('fixture TASKS directory has no .md stage')
  return Promise.all(stages.map(name => fs.readFile(path.join(directory, name), 'utf8')))
}
async function protectedFilesIn(directory: string, editable: readonly string[], prefix = ''): Promise<{ filename: string; content: Buffer }[]> {
  const result: { filename: string; content: Buffer }[] = []
  for (const entry of await fs.readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const filename = path.posix.join(prefix, entry.name)
    if (entry.isDirectory()) result.push(...await protectedFilesIn(directory, editable, filename))
    else if (entry.isFile() && !editable.includes(filename)) result.push({ filename, content: await fs.readFile(path.join(directory, filename)) })
    else if (!entry.isFile()) throw new Error(`invalid fixture initial entry: ${filename}`)
  }
  return result
}
export interface Acceptance {
  passed: boolean; exitCode: number | null; output: string; protectedFilesChanged: string[]
}
export async function createFixture(id: FixtureId) {
  if (!fixtureIds.includes(id)) throw new Error('unknown coding fixture')
  const source = path.join(fixtures, id)
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `mini-dsh-fixture-${id}-`))
  const workspace = path.join(directory, 'workspace')
  try {
    await fs.cp(path.join(source, 'initial'), workspace, { recursive: true, errorOnExist: true })
    const tasks = await readTaskSequence(source)
    const edits = await Promise.all(sources[id].map(async filename => ({
      path: filename,
      oldText: await fs.readFile(path.join(source, 'initial', filename), 'utf8'),
      newText: await fs.readFile(path.join(source, 'reference', filename), 'utf8'),
    })))
    const protectedFiles = await protectedFilesIn(path.join(source, 'initial'), sources[id])
    return {
      id, workspace, tasks, edits,
      async applyReference() {
        for (const edit of edits) await fs.writeFile(path.join(workspace, edit.path), edit.newText)
      },
      async evaluate({ timeoutMs = fixtureProcessTimeoutMs, maxOutputBytes = 32 * 1024 } = {}): Promise<Acceptance> {
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) throw new Error('invalid acceptance limits')
        const protectedFilesChanged: string[] = []
        for (const { filename, content } of protectedFiles) {
          try {
            const candidate = path.join(workspace, filename)
            if (!(await fs.lstat(candidate)).isFile() || !(await fs.readFile(candidate)).equals(content)) protectedFilesChanged.push(filename)
          } catch { protectedFilesChanged.push(filename) }
        }
        const result = spawnSync(process.execPath, [path.join(source, 'verify.mjs'), workspace], {
          cwd: workspace, encoding: 'utf8', timeout: timeoutMs, maxBuffer: maxOutputBytes, windowsHide: true,
        })
        const output = Buffer.from([result.error?.message, result.stdout, result.stderr].filter(Boolean).join('\n')).subarray(0, maxOutputBytes).toString('utf8')
        const marker = `acceptance passed: ${id}`
        return { passed: result.status === 0 && !result.error && output.trim() === marker && !protectedFilesChanged.length,
          exitCode: result.status, output, protectedFilesChanged }
      },
      async close() {
        if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith(`mini-dsh-fixture-${id}-`)) throw new Error('invalid fixture cleanup path')
        await fs.rm(directory, { recursive: true, force: true })
      },
    }
  } catch (error) {
    if (path.dirname(directory) !== path.resolve(os.tmpdir())) throw new Error('invalid fixture cleanup path', { cause: error })
    await fs.rm(directory, { recursive: true, force: true })
    throw error
  }
}
// fixture 目录里非 `initial/` / `reference/` 部位（目前只有 repair 的 `partial/` 中间态）的读取入口。
// 与 createFixture 一样从仓库根解析，调用方不必各自推算相对路径——演示脚本与用例走的是同一个坐标。
// 路径必须落在该 fixture 目录内：越界（绝对路径或 `..`）直接报错，而不是静默读到别处。
export async function readFixtureFile(id: FixtureId, relative: string): Promise<string> {
  if (!fixtureIds.includes(id)) throw new Error('unknown coding fixture')
  const base = path.join(fixtures, id), target = path.resolve(base, relative)
  if (!target.startsWith(base + path.sep)) throw new Error('fixture path escapes the fixture directory')
  return fs.readFile(target, 'utf8')
}
