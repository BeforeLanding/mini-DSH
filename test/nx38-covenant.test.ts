import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { evalPolicy } from '../scripts/eval-runner.js'
import { createFixture, fixtureProcessTimeoutMs, readFixtureFile } from '../scripts/coding-fixtures.js'
import { runFixtureTask } from '../scripts/eval-fixture.js'
import type { Fixture, FixtureAdapter } from '../scripts/eval-fixture.js'
import { assertToolProtocol } from '../src/core/context-runtime.js'
import type { ChatRequest, ChatResponse, SessionEvent, ToolCall } from '../src/core/contracts.js'

// NX-38-2：一台新任务类别仪器的**离线**机制证明，零付费。
//
// 它要回答的不是「某个模型行不行」，而是「这台仪器有没有分辨力」。NX-08h 的 blind 已经证伪了一条路
// （删掉工作区里的公开 oracle 不减判据，因为完整权威规格对确定性编程任务同时就是判据的载荷，根因是
// **可重建性**）。本仪器换掉的正是这一点：判据的某一段只写在第 1 阶段的排期说明正文里，`docs/SPEC.md`
// 不复述、也不可由它推导，因此它的载体**只有会话历史**。
//
// 「会话历史」这四个字下面有两条路，本文件分别钉住，别把它们混成一句：
//   · 裁剪：投影按 task 移除最旧的**完整**任务。免费、先做、没有回读入口（评测装配不注册 read_history）。
//     口径的载体是第 1 阶段的用户消息，只有这条路能把它拿走。
//   · 压缩：裁完还装不下（或已越过 `inputTargetTokens × compactionRatio`）时，Harness 把最旧的一段消息
//     交给**模型自己**写摘要再替换掉。它只规划当前 task 内部，动不到阶段说明——所以它是自救通道：
//     模型把口径写进摘要的 Critical Context，裁掉之后它仍然看得见。
// 探针是脚本化的，因此这里测到的是 **Harness 的机制**，不是模型行为：它**不回答**真实模型会不会丢，
// 也不回答真实模型会怎么写摘要——那是 NX-38-4 的付费跑要问的，本文件的结论不得外推。

const repository = fileURLToPath(new URL('../../', import.meta.url))
const initialDirectory = path.join(repository, 'test', 'fixtures', 'coding', 'ledger', 'initial')
const naiveDirectory = path.join(repository, 'test', 'fixtures', 'coding', 'ledger', 'naive', 'src')
// 阶段号 → 该阶段要落的文件。它与 `TASKS/*.md` 的文件名顺序、`sources.ledger` 的顺序三者必须一致：
// 适配器按这张表驱动，错位就会去改另一个阶段的文件，而结局看起来仍然「分叉」——只是分叉在别处。
const STAGE_FILES = ['src/parse.mjs', 'src/summarize.mjs', 'src/render.mjs', 'src/checksum.mjs']
// 口径的产物。工作区里任何一个文件出现它，等于口径被复述了；第 1 阶段的正文出现它则相反，是必须的。
const COVENANT_CHECKSUM = '550679'
const COVENANT_MARK = '绝对值'
const naiveSource = await readFixtureFile('ledger', 'naive/src/checksum.mjs')

async function filesUnder(directory: string): Promise<string[]> {
    const found: string[] = []
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name)
        if (entry.isDirectory()) found.push(...await filesUnder(target))
        else found.push(target)
    }
    return found
}

// ── 契约守卫（不跑引擎，快） ────────────────────────────────────────────────────────────────────

// 契约的第一条是「只在会话历史里」。它不是一句声明，而是可以被判红的两件事：工作区里没有口径的产物，
// 也没有口径的措辞；反过来，第 1 阶段的正文必须真的带着它，而且**只有**那一段带着——多写一处，裁剪
// 丢了它也不改变结局，整台仪器就成了摆设。
test('the covenant lives in the first stage only, and no workspace file restates or leaks it', async () => {
    const workspaceFiles = await filesUnder(initialDirectory)
    assert.ok(workspaceFiles.length >= 6, `only ${workspaceFiles.length} files under initial/, the fixture looks incomplete`)
    for (const file of workspaceFiles) {
        const content = await fs.readFile(file, 'utf8')
        const relative = path.relative(initialDirectory, file)
        assert.ok(!content.includes(COVENANT_CHECKSUM), `${relative} carries the agreed checksum, so the covenant is derivable from the workspace`)
        assert.ok(!content.includes(COVENANT_MARK), `${relative} restates the covenant, so pruning it would change nothing`)
    }
    // 验收器必须留在工作区之外：它是判据的另一半，进了工作区就不再独立。
    assert.ok(!workspaceFiles.includes(path.join(initialDirectory, 'verify.mjs')), 'verify.mjs must not ship inside the workspace')
    assert.ok(await fs.stat(path.join(initialDirectory, '..', 'verify.mjs')).then(() => true, () => false), 'verify.mjs must sit next to the fixture')

    const fixture = await createFixture('ledger')
    try {
        assert.equal(fixture.tasks.length, STAGE_FILES.length)
        assert.deepEqual(fixture.edits.map(edit => edit.path), STAGE_FILES)
        const carriers = fixture.tasks.filter(task => task.includes(COVENANT_MARK))
        assert.equal(carriers.length, 1, `the covenant appears in ${carriers.length} stages; it must be exactly one`)
        assert.equal(fixture.tasks.indexOf(carriers[0]), 0, 'the covenant must ride in the first stage')
    } finally { await fixture.close() }
})

// 契约的第三条是「自然」：口径不属于埋的陷阱，而属于「口头约定／临时约束」这一类真实信息。它成立的
// 前提是模型**能**靠它把活干对：参考解过公开检查也过独立验收，而「口径没接上」的对照物（naive）本地
// 一片绿、独立验收才红。少了后一半，这台仪器测到的就只是「有没有猜到某个数」。
test('the naive solution passes the public check and still fails independent acceptance', { timeout: 60_000 }, async () => {
    // naive/ 只放与参考解不同的那一份文件：结局的分叉只应归因到口径，多一处差别归因就不成立了。
    assert.deepEqual(await fs.readdir(naiveDirectory), ['checksum.mjs'])
    assert.notEqual(naiveSource, await readFixtureFile('ledger', 'reference/src/checksum.mjs'))

    const fixture = await createFixture('ledger')
    try {
        await fixture.applyReference()
        assert.equal((await fixture.evaluate()).passed, true)
        await fs.writeFile(path.join(fixture.workspace, 'src/checksum.mjs'), naiveSource)

        const check = spawnSync(process.execPath, ['check.mjs', '4'], { cwd: fixture.workspace, encoding: 'utf8', timeout: fixtureProcessTimeoutMs, windowsHide: true })
        assert.equal(check.status, 0, `the public check must stay green without the covenant: ${check.stderr}`)
        const rejected = await fixture.evaluate()
        assert.equal(rejected.passed, false)
        // 失败要指得出落在口径上，不能被格式断言吞掉——那会把「口径没接上」读成「文本格式不对」。
        assert.match(rejected.output, /checksum does not follow the agreed reconciliation basis/)
    } finally { await fixture.close() }
})

// ── 机制证明（跑引擎） ──────────────────────────────────────────────────────────────────────────

const WINDOW = 1_000_000
const COMPACTION_INSTRUCTION_MARK = '上面的对话正在被摘要'
// 模型自己写的摘要的两个版本，差别**只有**最后一行。这一行是模型的自由裁量，也正是分叉点：口径要么被它
// 带下去，要么就此失传。
const SUMMARY_WITHOUT_COVENANT = [
    '## Primary Request', '按 `docs/SPEC.md` 逐阶段实现「流水 → 台账」导出工具。',
    '## Files and Code', '`src/parse.mjs`、`src/summarize.mjs`、`src/render.mjs` 已按阶段落地。',
    '## Next Step', '实现 `src/checksum.mjs` 的 `checksum(entries)`。',
].join('\n')
const SUMMARY_WITH_COVENANT = `${SUMMARY_WITHOUT_COVENANT}\n## Critical Context\nchecksum 的口径：金额换算成分为单位的整数、取绝对值、再求和。`

interface Observation { stage: number; covenantVisible: boolean }
interface Probe { seen: Observation[]; summarised: number }

// 脚本化适配器是**探针**而不是模型替身：它每阶段读一个文件、再改它，而**改什么内容取决于它此刻还能不能
// 看见那条口径**。被调用时若发现自己在回答压缩请求，就交出一份给定的摘要——那是模型在真实跑里唯一能影响
// 「裁掉之后还剩什么」的地方。
function probeAdapter(fixture: Fixture, probe: Probe, summary: string): FixtureAdapter {
    let stage = -1
    let queue: ToolCall[] = []
    return {
        provider: 'scripted', model: 'fixture', capabilities: { fixture: { contextWindowTokens: WINDOW } },
        chat: async ({ messages = [] }: ChatRequest): Promise<ChatResponse> => {
            assertToolProtocol(messages)
            const users = messages.filter(message => message.role === 'user').map(message => String(message.content ?? ''))
            if (users.some(content => content.includes(COMPACTION_INSTRUCTION_MARK))) {
                probe.summarised += 1
                return { content: summary }
            }
            // 「口径还在不在」按特征词找，而不是按第 1 阶段整段文字相等：裁掉之后它可能只剩在摘要的 frame 里，
            // 那是模型真能看见的。判据必须落在「此刻看不看得见」，不是「日志里还留着原文」。
            const covenantVisible = users.some(content => content.includes(COVENANT_MARK))
            // 当前阶段按「哪一段阶段说明还在」取最高编号：压缩请求之外的报文里当前阶段说明必须还在，
            // 否则是仪器故障而不是结局。
            const at = fixture.tasks.reduce((found, task, index) => users.includes(task) ? index : found, -1)
            assert.ok(at >= 0, 'the current stage text must still be in the request, otherwise the probe cannot be driven')
            if (at !== stage) {
                stage = at
                probe.seen.push({ stage: at, covenantVisible })
                const target = STAGE_FILES[at]
                const edit = fixture.edits.find(candidate => candidate.path === target)
                assert.ok(edit, `stage ${at + 1} must correspond to an editable file`)
                // 最后一个阶段落的正是口径决定的那份文件：写参考解还是写「口径没接上」的版本，只取决于此刻
                // 还看不看得见。
                const newText = at === STAGE_FILES.length - 1 && !covenantVisible ? naiveSource : edit.newText
                queue = [
                    { id: `read-${at}`, name: 'read_file', arguments: { path: target } },
                    { id: `write-${at}`, name: 'edit_file', arguments: { path: target, oldText: edit.oldText, newText } },
                ]
            }
            return queue.length ? { toolCalls: [queue.shift()!] } : { content: `stage ${at + 1} finished` }
        },
    }
}

// 压缩是否真的发生只能从事件流读：投影只记「裁掉了哪些 task」，摘要是另一类事件。
async function runProbe(budget: Readonly<typeof evalPolicy>, summary: string) {
    const probe: Probe = { seen: [], summarised: 0 }
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nx38-ledger-'))
    try {
        const outcome = await runFixtureTask('ledger', fixture => probeAdapter(fixture, probe, summary), budget, directory)
        const [session] = await fs.readdir(directory)
        const events = (await fs.readFile(path.join(directory, session!, 'events.jsonl'), 'utf8')).trim().split('\n')
            .map(line => JSON.parse(line) as SessionEvent)
        const applied = events.filter(event => event.type === 'context/summary-end' && event.data.outcome.kind === 'applied').length
        return { outcome, probe, applied }
    } finally { await fs.rm(directory, { recursive: true, force: true }) }
}

// 有裁剪档的目标由无裁剪档的实测现算：取整条序列峰值的 3/4。它的两条边界都由断言当场核对——必须低于
// 最后一个阶段开始前的累计规模（否则根本不会裁，仪器退化成无裁剪档），也必须容得下裁完之后剩下的
// 「固定开销 + 当前阶段自身」（否则结局是 context_overflow，量到的是另一回事）。
const targetFor = (peak: number) => Math.floor(peak * 0.75)
const peakOf = (outcome: { tasks?: { maxEstimatedInputTokens?: number }[] }) =>
    Math.max(...(outcome.tasks ?? []).map(stage => stage.maxEstimatedInputTokens ?? 0))

test('pruning alone drops the covenant, and the verifier goes red on exactly that line', { timeout: 180_000 }, async () => {
    // 把主动压缩的阈值抬到窗口，让两档都只剩「投影按 task 裁剪」这一条路：被测量因此是**裁剪**，而不是
    // 「裁剪 + 模型自己的摘要」的混合物。两档唯一的差别仍然只有 inputTargetTokens。
    const noPrune = { ...evalPolicy, inputTargetTokens: WINDOW, compactionBudgetTokens: WINDOW }
    const baseline = await runProbe(noPrune, SUMMARY_WITH_COVENANT)
    assert.equal(baseline.outcome.accepted, true, baseline.outcome.acceptance?.output)
    const target = targetFor(peakOf(baseline.outcome))
    assert.ok(target < peakOf(baseline.outcome))

    const pruning = await runProbe({ ...noPrune, inputTargetTokens: target }, SUMMARY_WITH_COVENANT)
    const withoutTarget = (policy: typeof noPrune) => Object.fromEntries(Object.entries(policy).filter(([key]) => key !== 'inputTargetTokens'))
    assert.deepEqual(withoutTarget(noPrune), withoutTarget({ ...noPrune, inputTargetTokens: target }))

    // 层 A：处理必须真的发生，且必须是「裁剪」这一条——压缩一次都不许有，否则这条用例证明的就不是它自称的东西。
    assert.equal(baseline.applied, 0)
    assert.equal(pruning.applied, 0, 'the pruning tier must not reach the compaction path')
    assert.ok((baseline.outcome.tasks ?? []).every(stage => stage.removedTaskIds.length === 0), 'the unbounded tier must never prune')
    assert.ok((pruning.outcome.tasks ?? []).every(stage => stage.status !== 'context_overflow'), 'the pruning tier must prune, not overflow')
    const firstTask = pruning.outcome.tasks![0].taskId
    assert.ok(pruning.outcome.tasks!.some(stage => stage.removedTaskIds.includes(firstTask)), 'the pruning tier must drop the first stage')
    assert.equal(baseline.probe.seen[0].covenantVisible, true, 'the fixture must carry the covenant in its first stage')
    assert.equal(baseline.probe.seen.at(-1)!.covenantVisible, true, 'without pruning the covenant must stay visible to the probe')
    assert.equal(pruning.probe.seen[0].covenantVisible, true)
    assert.equal(pruning.probe.seen.at(-1)!.covenantVisible, false, 'the probe must see the covenant gone before the last stage writes')

    // 层 B：层 A 成立，才解释结局。
    assert.equal(pruning.outcome.accepted, false)
    assert.match(pruning.outcome.acceptance?.output ?? '', /checksum does not follow the agreed reconciliation basis/)
    // 分叉只落在口径那一条上：验收输出里不能同时冒出格式或汇总的失败，否则红得没有归因。
    assert.doesNotMatch(pruning.outcome.acceptance?.output ?? '', /ledger body does not match|summary rows|skipped line numbers/)
})

// 压缩这条路反过来是模型的自救通道：压缩只在当前 task 内部规划，动不到任何阶段的说明，所以口径失传只可能
// 来自裁剪；而裁剪之后，模型**自己写的摘要**是唯一还能把口径带下去的东西。
// 两次运行的预算逐字相同，唯一差别是摘要里有没有那一行——结局跟着它走，说明仪器量到的确实是「口径还在不在」。
test('after pruning, what survives is only what the model own summary carried forward', { timeout: 180_000 }, async () => {
    const baseline = await runProbe({ ...evalPolicy, inputTargetTokens: WINDOW }, SUMMARY_WITH_COVENANT)
    const budget = { ...evalPolicy, inputTargetTokens: targetFor(peakOf(baseline.outcome)) }

    const dropped = await runProbe(budget, SUMMARY_WITHOUT_COVENANT)
    const kept = await runProbe(budget, SUMMARY_WITH_COVENANT)

    // 层 A：压缩必须真的发生，而且两次一样多——否则「摘要内容决定结局」这句话没有立足点。
    assert.ok(dropped.applied > 0, 'the production-default tier must reach the compaction path')
    assert.equal(dropped.applied, kept.applied, 'both runs must compact the same number of times')
    assert.ok((dropped.outcome.tasks ?? []).every(stage => stage.status !== 'context_overflow'))
    assert.ok((kept.outcome.tasks ?? []).every(stage => stage.status !== 'context_overflow'))
    assert.ok(dropped.outcome.tasks!.some(stage => stage.removedTaskIds.length > 0), 'the covenant must have lost its carrier to pruning')

    // 层 B：只差摘要里的一行，结局分叉。
    assert.equal(dropped.probe.seen.at(-1)!.covenantVisible, false)
    assert.equal(dropped.outcome.accepted, false)
    assert.match(dropped.outcome.acceptance?.output ?? '', /checksum does not follow the agreed reconciliation basis/)
    assert.equal(kept.probe.seen.at(-1)!.covenantVisible, true)
    assert.equal(kept.outcome.accepted, true, kept.outcome.acceptance?.output)
})
