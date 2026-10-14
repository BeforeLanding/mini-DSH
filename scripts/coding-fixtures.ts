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
// NX-38 的仪器：一套**新任务类别**（流水 → 台账导出的多阶段序列），它的判据有一段只写在第 1 阶段的
// 排期说明正文里，工作区里没有副本、也不可由 `docs/SPEC.md` 推导。它问的问题与 blind 不同：blind 问
// 「没有公开 oracle 时能否按 SPEC 独立产出正确实现」（已被 NX-08h 证伪——完整权威规格对确定性编程任务
// 同时就是判据的载荷）；它问「判据的载体本身在会话历史里，被裁剪之后还守不守得住」。
// 它不进 sequenceIds：`phaseCaps.sequence.runs = 1` 而 registry 会有 2 项，`repeatCount(1, 2)` 直接抛
// 「cannot be split evenly」；即便整除，也会让对照 A 的两臂拿到不同的任务集，把「上下文策略」换成
// 「任务难度」。它也不进筛查批次（那 12 个已冻结）。因此单独一份注册表。
// 无付费批次：NX-38-2 只做离线机制证明（test/nx38-covenant.test.ts），正式批次的上限与判据要另行预注册。
export const ledgerIds = ['ledger'] as const
// NX-39「代码理解」类。判据是 **FAIL_TO_PASS**：agent 的产物必须在**原始缺陷**上非零退出、在 `reference/`
// 上恰好 0 退出。它们与既有六份注册表形状不同——可改文件为空（`sources[id] = []`），于是 `initial/` 里的
// 每个文件都自动进受保护集合，而 agent **新建**的产物因为不在 `initial/` 里天然可写；判据则落在工作区
// 之外的新验收器上（`verify.mjs` 转交 `_shared/criteria.mjs`）。因此单独一份注册表。
export const comprehensionIds = ['repro-sessions', 'repro-money', 'repro-tally', 'repro-order'] as const
// NX-39「测试编写」类。判据是**变异得分**：agent 的测试在原始源码上必须全绿、杀掉 ≥ `minKilled` 个变异体、
// 且**不杀**行为保持的等价体。与 comprehensionIds 同形（可改文件为空、判据在工作区之外）。
// 「不杀等价体」那一条是这一类的**主要防过拟合机制**：靠比对源码文本或哈希来判定「还是不是原来那份」的
// 产物，会把与自己文本不同的等价体一并杀掉，于是当场判失败——这正是 ③a 记下的那处已知缺口
// （repro 判据只看退出码，比对源码文本的产物可绕过）在这里被堵上的方式。
export const mutationIds = ['mutation-bands', 'mutation-quota', 'mutation-slug', 'mutation-versions'] as const
export const fixtureIds = [...screeningIds, ...sequenceIds, ...boundedIds, ...demoIds, ...blindIds, ...ledgerIds, ...comprehensionIds, ...mutationIds] as const
export type FixtureId = typeof fixtureIds[number]
// 三个种类。既有 17 个 fixture 全是 `edit`（就地改既有源码），行为逐字不变。
// 新两类的共同点：判据不落在「工作区的终态长什么样」上，而落在「agent 新建的那份产物运行起来对不对」上，
// 因此验收器需要一个工作区之外的报告目录来放中间产物与读数。
export type FixtureKind = 'edit' | 'repro' | 'mutation'
export function fixtureKind(id: FixtureId): FixtureKind {
  if ((comprehensionIds as readonly FixtureId[]).includes(id)) return 'repro'
  if ((mutationIds as readonly FixtureId[]).includes(id)) return 'mutation'
  return 'edit'
}
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
  // 顺序必须与 TASKS/*.md 的文件名顺序一致：test/nx38-covenant.test.ts 按阶段号取第 N 个 edit 来驱动
  // 脚本化适配器，并把这条对应关系单独断言了一遍。`data/` 与 `docs/SPEC.md` 不在表内，因而都在受保护
  // 集合里——判据的副本不能由工作区承载，这是本 fixture 成立的前提。
  ledger: ['src/parse.mjs', 'src/summarize.mjs', 'src/render.mjs', 'src/checksum.mjs'],
  // NX-39 的两个新种类**没有可改文件**。这不是省事，而是它们要的形状：`initial/` 里的规格、源码与
  // 配置全部进受保护集合（agent 不得就地改源码来「修好」它），而 agent 要交的产物是**新建**的文件——
  // 它不在 `initial/` 里，因此天然可写，无需另立一条「允许新建」的规则。
  'repro-sessions': [], 'repro-money': [], 'repro-tally': [], 'repro-order': [],
  // 「测试编写」类同形：`initial/` 里的**正确**实现、公开的 `check.mjs`、规格与配置全部进受保护集合
  // （agent 不得改源码或改公开检查来「让测试过」），而 agent 要交的 `suite.mjs` 是新建的文件。
  'mutation-bands': [], 'mutation-quota': [], 'mutation-slug': [], 'mutation-versions': [],
}
async function exists(target: string): Promise<boolean> { return fs.stat(target).then(() => true, () => false) }
// Harness 自己数变异体与等价体的目录项。数不出来（目录不存在）时返回 0，于是读数里报的任何正数都对不上。
async function countDirectories(directory: string): Promise<number> {
  try { return (await fs.readdir(directory, { withFileTypes: true })).filter(entry => entry.isDirectory()).length } catch { return 0 }
}
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
// 新种类的判据**读数**。它由工作区之外的验收器写进 `report.json`，Harness 读回来后再用自己的规则
// 复算一遍（见 evidencePasses），两边不一致即失败——否则「这份判据的规则」与「Harness 认定的规则」
// 会悄无声息地漂开，而这正是判据本身没人能核对的那类失效。
export interface ReproEvidence {
  kind: 'repro'; artifact: string
  // 同一份产物在两份源码上的退出码：原始缺陷上必须非零，reference/ 上必须恰好 0（FAIL_TO_PASS）。
  // spawn 失败（超时、被输出上限掐掉）记 null，而 null 永远不被当成成功。
  initialExitCode: number | null; referenceExitCode: number | null
  /** 验收器自己算出的结论；Harness 复算并比对。 */
  passed: boolean
  reason?: string
}
// 「测试编写」类的读数。变异体与等价体的**总数**也在里面，但它们不由验收器说了算——Harness 自己数
// 目录，两边对不上就当没有读数（见 readEvidence）。否则一个只跑了一个变异体、却自称总数为一的验收器
// 可以完全自洽地通过。
export interface MutationEvidence {
  kind: 'mutation'; artifact: string
  /** 阈值，来自 `criteria.json`；Harness 用自己的那份比对，不采信读数里这个数。 */
  minKilled: number
  /** 原始（正确）源码上必须**恰好 0**。spawn 失败记 null，而 null 永远不被当成成功。 */
  originalExitCode: number | null
  mutantsTotal: number; mutantsKilled: number
  /** 没能跑完的变异体（超时、被输出上限掐掉）。它不是「杀灭」——超时不是发现缺陷——任何一份都判失败。 */
  mutantsUnrunnable: number
  equivalentsTotal: number
  /** 被杀掉的行为保持等价体数，**必须为 0**。跑不完的等价体也记在这里。 */
  equivalentsKilled: number
  /** 验收器自己算出的结论；Harness 复算并比对。 */
  passed: boolean
  reason?: string
}
export type AcceptanceEvidence = ReproEvidence | MutationEvidence
function evidencePasses(evidence: AcceptanceEvidence): boolean {
  if (evidence.kind === 'repro') return evidence.initialExitCode !== null && evidence.initialExitCode !== 0 && evidence.referenceExitCode === 0
  if (evidence.kind === 'mutation') return evidence.originalExitCode === 0 && evidence.mutantsUnrunnable === 0 && evidence.mutantsKilled >= evidence.minKilled && evidence.equivalentsKilled === 0
  return false
}
export interface Acceptance {
  passed: boolean; exitCode: number | null; output: string; protectedFilesChanged: string[]
  evidence?: AcceptanceEvidence
}
// Harness 期望看到的读数形状。它来自 fixture 自己的装配（`criteria.json` 与 `mutants/`／`equivalents/`
// 的目录项），不是从 report.json 抄回来的——抄回来的话，两边就永远一致，这道比对也就白设了。
type ExpectedEvidence =
  | { kind: 'repro' }
  | { kind: 'mutation'; minKilled: number; mutantsTotal: number; equivalentsTotal: number }
// report.json 是判据自己写的文件，因此按「不可信输入」读：解析失败、形状不对、或是还没实现的种类，
// 一律当作**没有读数**，而不是猜一个默认值出来。变异读数还要与 Harness 自己数的目录对得上：阈值、
// 变异体总数、等价体总数三项里有一项对不上就整份作废。
async function readEvidence(reportDirectory: string, expected: ExpectedEvidence): Promise<AcceptanceEvidence | undefined> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path.join(reportDirectory, 'report.json'), 'utf8'))
    if (!parsed || typeof parsed !== 'object') return undefined
    const candidate = parsed as AcceptanceEvidence
    if (typeof candidate.artifact !== 'string' || typeof candidate.passed !== 'boolean') return undefined
    if (expected.kind === 'repro') return candidate.kind === 'repro' ? candidate : undefined
    if (candidate.kind !== 'mutation') return undefined
    return candidate.minKilled === expected.minKilled && candidate.mutantsTotal === expected.mutantsTotal && candidate.equivalentsTotal === expected.equivalentsTotal
      ? candidate : undefined
  } catch { return undefined }
}
// `criteria.json` 把「产物叫什么」这件事放在 fixture 自己身上：验收器与 Harness 读的是同一个文件，
// 因而不会出现两处各写一遍、改一处漏一处。kind 必须与注册表一致——否则一个 fixture 可以声明自己是
// repro 而注册表把它当 edit 跑，两边都能自洽，谁也不会报错。
async function readCriteria(source: string, id: FixtureId): Promise<{ artifact: string; minKilled?: number } | undefined> {
  const kind = fixtureKind(id)
  if (kind === 'edit') return undefined
  const criteria: unknown = JSON.parse(await fs.readFile(path.join(source, 'criteria.json'), 'utf8'))
  const record = criteria as { kind?: unknown; artifact?: unknown; minKilled?: unknown }
  if (record.kind !== kind) throw new Error(`fixture ${id} declares kind ${String(record.kind)} but its registry says ${kind}`)
  if (typeof record.artifact !== 'string' || !record.artifact || path.isAbsolute(record.artifact) || record.artifact.split(/[\\/]/).includes('..')) {
    throw new Error(`fixture ${id} declares an invalid criteria artifact: ${String(record.artifact)}`)
  }
  if (kind === 'mutation') {
    // 阈值必须在装配时就合法：验收器也会自己再查一遍，但那时已经是「判据自己声明自己的门槛」了。
    if (!Number.isSafeInteger(record.minKilled) || (record.minKilled as number) <= 0) throw new Error(`fixture ${id} declares an invalid minKilled: ${String(record.minKilled)}`)
    return { artifact: record.artifact, minKilled: record.minKilled as number }
  }
  return { artifact: record.artifact }
}
export async function createFixture(id: FixtureId) {
  if (!fixtureIds.includes(id)) throw new Error('unknown coding fixture')
  const kind = fixtureKind(id)
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
    const criteria = await readCriteria(source, id)
    // 参考产物必须来自 fixture 目录，**不能**由工作区推导（R-23）。它在门禁里充当正例：把它放进工作区
    // 之后验收必须通过，而放 weak/ 里那份反例产物必须判不过——判据不是白送的，靠这一对量出来。
    const artifact = criteria === undefined ? undefined : { path: criteria.artifact, content: await fs.readFile(path.join(source, 'oracle', criteria.artifact), 'utf8') }
    const expected: ExpectedEvidence | undefined = criteria === undefined ? undefined : criteria.minKilled === undefined ? { kind: 'repro' } : {
      kind: 'mutation', minKilled: criteria.minKilled,
      mutantsTotal: await countDirectories(path.join(source, 'mutants')),
      equivalentsTotal: await countDirectories(path.join(source, 'equivalents')),
    }
    return {
      id, kind, workspace, tasks, edits, artifact, minKilled: criteria?.minKilled,
      async applyReference() {
        // edit：就地改既有源码，与历史逐字相同。
        if (kind === 'edit') {
          for (const edit of edits) await fs.writeFile(path.join(workspace, edit.path), edit.newText)
          return
        }
        // 新种类的「参考态」**只有产物这一半**：源码那一半从不进工作区。`reference/` 只被验收器用在
        // 工作区副本上（repro 就是靠它造出「修好之后」的那一份），一旦把它覆盖进工作区，agent 的产物
        // 在「缺陷」上也照样通过——判据会当场失效，而且失效得毫无征兆。这条曾经写错过一版，由
        // fixtures:check 逮到：那次 reference 态报 initialExitCode=0 且受保护文件被改。
        if (artifact) await fs.writeFile(path.join(workspace, artifact.path), artifact.content)
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
        // 只有新种类才开报告目录，且开在 fixture 自己的临时目录里（工作区之外，因此不混进上面的字节比对，
        // 又随 close() 一起消失）。edit 种类连 argv 都不多一个，既有 17 个 fixture 的 spawn 逐字不变。
        const reportDirectory = artifact === undefined ? undefined : path.join(directory, 'report')
        if (reportDirectory !== undefined) {
          await fs.rm(reportDirectory, { recursive: true, force: true })
          await fs.mkdir(reportDirectory, { recursive: true })
        }
        const result = spawnSync(process.execPath, [path.join(source, 'verify.mjs'), workspace, ...(reportDirectory === undefined ? [] : [reportDirectory])], {
          cwd: workspace, encoding: 'utf8', timeout: timeoutMs, maxBuffer: maxOutputBytes, windowsHide: true,
        })
        const output = Buffer.from([result.error?.message, result.stdout, result.stderr].filter(Boolean).join('\n')).subarray(0, maxOutputBytes).toString('utf8')
        const marker = `acceptance passed: ${id}`
        const evidence = reportDirectory === undefined || expected === undefined ? undefined : await readEvidence(reportDirectory, expected)
        // 三个条件缺一不可：退出码与标记照旧，且新种类还必须带上**自洽的读数**——验收器没写报告、
        // 或它自己算的结论与复算不一致，都判失败。
        const consistent = evidence !== undefined && evidence.passed === evidencePasses(evidence) && evidence.passed
        return { passed: result.status === 0 && !result.error && output.trim() === marker && !protectedFilesChanged.length && (artifact === undefined || consistent),
          exitCode: result.status, output, protectedFilesChanged, ...(evidence === undefined ? {} : { evidence }) }
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
