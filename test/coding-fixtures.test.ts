import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import { createFixture, screeningIds, sequenceIds, boundedIds, demoIds, blindIds, fixtureProcessTimeoutMs, readTaskSequence, readFixtureFile } from '../scripts/coding-fixtures.js'
import type { FixtureId } from '../scripts/coding-fixtures.js'
import { batchPhases, evalPolicy } from '../scripts/eval-runner.js'
import { phaseRegistry } from '../scripts/eval-cli.js'
import type { ToolCall } from '../src/core/contracts.js'
import { assertToolProtocol } from '../src/core/context-runtime.js'
import { estimateText } from '../src/core/token-estimator.js'
import * as sessions from '../src/plugins/session.js'
import * as systemPrompt from '../src/plugins/system-prompt.js'
import * as tools from '../src/plugins/tools.js'
import * as llm from '../src/plugins/llm.js'
import * as agents from '../src/plugins/agent.js'
import * as agentLoop from '../src/plugins/agent-loop.js'
import * as sandbox from '../src/plugins/sandbox.js'
import * as files from '../src/tools/files.js'
import * as bash from '../src/tools/bash.js'

const locationCases: Record<string, { token: string; source: string }> = {
  pagination: { token: 'NX05B-PAGE-LOCATE', source: 'src/page.mjs' },
  query: { token: 'NX05B-QUERY-LOCATE', source: 'src/query.mjs' },
  csv: { token: 'NX05B-CSV-LOCATE', source: 'src/csv.mjs' },
}

// 逐 fixture 的两个用例只对筛查批次的单任务 fixture 成立：它们发送 fixture.tasks[0] 并断言工作区终态，
// 多阶段序列要到最后一个阶段才验收，进这个循环会假失败。多阶段路径另有用例覆盖。
for (const id of screeningIds) {
  test(`coding fixture ${id}: initial failure, reference acceptance and fresh workspace`, async () => {
    const fixture = await createFixture(id), fresh = await createFixture(id)
    try {
      assert.notEqual(fixture.workspace, fresh.workspace)
      const location = locationCases[id]
      if (location) {
        const log = await fs.readFile(path.join(fixture.workspace, 'diagnostics/trace.log'), 'utf8')
        assert.ok(Buffer.byteLength(log) > 32 * 1024)
        assert.ok(log.split('\n').findIndex(line => line.includes(location.token)) >= 200)
        assert.match(log, new RegExp(`${location.token}: ${location.source.replaceAll('.', '\\.')}`))
      }
      const initial = await fixture.evaluate()
      assert.equal(initial.passed, false)
      assert.equal(initial.exitCode, 1, initial.output)
      assert.match(initial.output, /AssertionError/)
      await fixture.applyReference()
      const reference = await fixture.evaluate()
      assert.equal(reference.passed, true, reference.output)
      assert.equal((await fresh.evaluate()).passed, false)
    } finally { await fixture.close(); await fresh.close() }
    await assert.rejects(fs.access(fixture.workspace))
    await assert.rejects(fs.access(fresh.workspace))
  })

  test(`coding fixture ${id}: scripted model reads, edits and reruns real checks`, { timeout: 30_000 }, async () => {
    const fixture = await createFixture(id), root = new Context()
    try {
      for (const plugin of [sessions, systemPrompt, tools, llm, agents, agentLoop]) await root.plugin(plugin)
      await root.plugin(sandbox, { workspace: fixture.workspace, autoApprove: true })
      await root.plugin(files); await root.plugin(bash)
      const location = locationCases[id]
      const commands: ToolCall[] = location ? [
        { id: 'locate', name: 'grep', arguments: { path: 'diagnostics', query: location.token } },
        { id: 'inspect-log', name: 'read_file', arguments: { path: 'diagnostics/trace.log', startLine: 319, maxLines: 3 } },
      ] : []
      commands.push(...fixture.edits.map((edit, index) => ({ id: `read-${index}`, name: 'read_file', arguments: { path: edit.path } })))
      commands.push({ id: 'before', name: 'bash', arguments: { command: 'node check.mjs' } })
      if (id === 'options') {
        const edit = fixture.edits[0]
        const provisional = "export function joinWords(words, { separator = ', ' } = {}) {\n  return words.join(separator)\n}\n"
        commands.push({ id: 'partial-edit', name: 'edit_file', arguments: { ...edit, newText: provisional } })
        commands.push({ id: 'retry-fails', name: 'bash', arguments: { command: 'node check.mjs' } })
        commands.push({ id: 'correct-edit', name: 'edit_file', arguments: { ...edit, oldText: provisional } })
      } else for (const [index, edit] of fixture.edits.entries()) commands.push({ id: `edit-${index}`, name: 'edit_file', arguments: edit })
      commands.push({ id: 'after', name: 'bash', arguments: { command: 'node check.mjs' } })
      let step = 0
      const checks: boolean[] = []
      root.llm.register('scripted', { models: ['fixture'], chat: async ({ messages = [] }) => {
        assertToolProtocol(messages)
        const previous = commands[step - 1]
        if (previous) {
          const result = messages.at(-1)!
          assert.equal(result.role, 'tool')
          assert.equal(result.tool_call_id, previous.id)
          if (previous.name === 'bash') {
            const command = JSON.parse(result.content ?? '{}')
            assert.equal(command.exitCode, previous.id === 'after' ? 0 : 1)
            if (previous.id === 'after') assert.match(command.stdout.text, /public checks passed/)
          }
          else {
            assert.doesNotMatch(result.content ?? '', /ToolError:/)
            if (previous.id === 'locate' || previous.id === 'inspect-log') assert.match(result.content ?? '', new RegExp(location!.token))
          }
        }
        return step < commands.length ? { toolCalls: [commands[step++]] } : { content: 'scripted fixture finished' }
      } })
      const session = root.sessions.create({ source: 'coding-fixture', fixtureId: id })
      const agent = root.agents.create({ sessionId: session.id, model: 'scripted/fixture', loop: root.agentLoop,
        budget: { maxModelRequests: 16, maxToolCalls: 16, maxActiveDurationMs: 20_000 } })
      assert.equal(await agent.send(fixture.tasks[0], { onToolResult: result => { if (result.name === 'bash') checks.push(!result.isError) } }), 'scripted fixture finished')
      assert.deepEqual(checks, id === 'options' ? [false, false, true] : [false, true])
      assert.equal(root.sessions.latestRun(session.id)?.status, 'completed')
      const acceptance = await fixture.evaluate()
      assert.equal(acceptance.passed, true, acceptance.output)
      assert.equal(session.events.filter(e => e.type === 'tool/result').length, commands.length)
      assertToolProtocol(root.sessions.deriveMessages(session.id))
    } finally { await root.fiber.dispose(); await fixture.close() }
  })
}

test('independent acceptance rejects bypassed public checks, partial migration and early exit', async () => {
  const fixture = await createFixture('interface')
  try {
    const originalCheck = await fs.readFile(path.join(fixture.workspace, 'check.mjs'))
    await fs.writeFile(path.join(fixture.workspace, 'check.mjs'), "console.log('public checks passed')\n")
    const publicResult = spawnSync(process.execPath, ['check.mjs'], { cwd: fixture.workspace, encoding: 'utf8', timeout: fixtureProcessTimeoutMs, windowsHide: true })
    assert.equal(publicResult.status, 0)
    const tampered = await fixture.evaluate()
    assert.equal(tampered.passed, false)
    assert.deepEqual(tampered.protectedFilesChanged, ['check.mjs'])
    await fixture.applyReference()
    assert.equal((await fixture.evaluate()).passed, false)
    await fs.writeFile(path.join(fixture.workspace, 'check.mjs'), originalCheck)
    await fs.writeFile(path.join(fixture.workspace, 'src/receipt.mjs'), fixture.edits[1].oldText)
    assert.equal((await fixture.evaluate()).passed, false)
    await fs.writeFile(path.join(fixture.workspace, 'src/pricing.mjs'), 'process.exit(0)\n')
    const bypass = await fixture.evaluate()
    assert.equal(bypass.exitCode, 0)
    assert.equal(bypass.passed, false)
  } finally { await fixture.close() }
})

test('merge fixture requires both entry point and helper migration', async () => {
  const fixture = await createFixture('merge')
  try {
    for (const edit of fixture.edits) {
      await fs.writeFile(path.join(fixture.workspace, edit.path), edit.newText)
      assert.equal((await fixture.evaluate()).passed, false, `partial merge unexpectedly passed: ${edit.path}`)
      await fs.writeFile(path.join(fixture.workspace, edit.path), edit.oldText)
    }
    await fixture.applyReference()
    assert.equal((await fixture.evaluate()).passed, true)
  } finally { await fixture.close() }
})

test('independent acceptance protects nested diagnostic evidence', async () => {
  const fixture = await createFixture('boundary')
  try {
    const diagnostic = path.join(fixture.workspace, 'diagnostics/context.txt')
    await fixture.applyReference()
    assert.equal((await fixture.evaluate()).passed, true)
    await fs.writeFile(diagnostic, 'forged diagnostic\n')
    const result = await fixture.evaluate()
    assert.equal(result.passed, false)
    assert.deepEqual(result.protectedFilesChanged, ['diagnostics/context.txt'])
  } finally { await fixture.close() }
})

test('stage layout reads TASKS in name order and refuses the ambiguous layouts', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-sequence-'))
  try {
    const stages = path.join(root, 'TASKS')
    await fs.mkdir(stages)
    // 写入顺序与期望顺序不同：承载阶段顺序的必须是文件名（01-/02- 前缀），不是目录项返回顺序。
    await fs.writeFile(path.join(stages, '02-second.md'), 'second')
    await fs.writeFile(path.join(stages, '01-first.md'), 'first')
    await fs.writeFile(path.join(stages, 'notes.txt'), 'ignored')
    assert.deepEqual(await readTaskSequence(root), ['first', 'second'])

    await fs.writeFile(path.join(root, 'TASK.md'), 'single')
    await assert.rejects(readTaskSequence(root), /both TASK\.md and TASKS\//)

    await fs.rm(stages, { recursive: true })
    assert.deepEqual(await readTaskSequence(root), ['single'])

    await fs.rm(path.join(root, 'TASK.md'))
    await fs.mkdir(stages)
    await fs.writeFile(path.join(stages, 'notes.txt'), 'ignored')
    await assert.rejects(readTaskSequence(root), /no \.md stage/)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('the screening batch is still twelve single-task fixtures', async () => {
  // 阶段序列只对声明了 TASKS/ 的 fixture 生效。这条断言固定「筛查批次的 12 个 fixture 与多阶段改造
  // 之前完全一致」，否则离线基线与筛查跑的历史结果都不能再当作对照。
  for (const id of screeningIds) {
    const fixture = await createFixture(id)
    try { assert.equal(fixture.tasks.length, 1) } finally { await fixture.close() }
  }
})

// 对照 B 的仪器。它必须是单任务（有界工具输出改变的是当前 task 内部的历史规模，多阶段会把可裁剪的旧
// 任务引进来，那是对照 A 的自变量），且必须不属于另外两批——进了筛查批次会动 NX-08d 的 12/12 与它的
// 上限，进了阶段序列会被当成多阶段 fixture。
test('the bounded-tool-output fixture is a single task whose report dwarfs the input target', { timeout: 60_000 }, async () => {
  assert.deepEqual([...boundedIds], ['audit'])
  const otherBatches: readonly string[] = [...screeningIds, ...sequenceIds, ...blindIds]
  for (const id of boundedIds) assert.ok(!otherBatches.includes(id), `${id} must stay out of the other batches`)
  const fixture = await createFixture('audit')
  try {
    assert.equal(fixture.tasks.length, 1, 'the tool-output instrument must be a single task')

    // 公开检查只有一条断言：它失败时指不出是哪条记录、哪个字段，因此模型必须去跑 report.mjs。少了这条
    // 性质，模型可以直接读 check.mjs 反推出全部规则，报告就不会被跑，「无界」那一臂也就不会产生大输出。
    const check = spawnSync(process.execPath, ['check.mjs'], { cwd: fixture.workspace, encoding: 'utf8', timeout: fixtureProcessTimeoutMs, windowsHide: true })
    assert.equal(check.status, 1)
    assert.match(check.stderr, /AssertionError/)
    assert.doesNotMatch(check.stderr + check.stdout, /field=/, 'the public check must not point at a field')

    // 报告输出是这台仪器的作用量：它必须远大于输入目标，否则无界臂不会溢出、对照没有分辨力。用项目自己的
    // 估算器量而不是字节数——CJK 与 ASCII 的 token 单价不同，字节数会给出错误的余量。
    const report = spawnSync(process.execPath, ['report.mjs'], { cwd: fixture.workspace, encoding: 'utf8', timeout: fixtureProcessTimeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true })
    assert.equal(report.status, 0, report.stderr)
    assert.ok(Buffer.byteLength(report.stdout) > 512 * 1024, `report was ${Buffer.byteLength(report.stdout)} bytes`)
    // 余量取 3 倍：报告必须大到「一条不截断的结果就足以把当前 task 顶过输入目标」，而不是刚刚够。实测
    // 3.41 倍（745,243 字节 / 223,573 估算 token）；NX-08f-4c 从报告里去掉散文规则后由 4.23 倍降到这个值。
    assert.ok(estimateText(report.stdout) > 3 * (evalPolicy.inputTargetTokens ?? 0), `report was ${estimateText(report.stdout)} tokens`)
    // 三条缺陷轴各自都要有违规：只有一条轴时「报告里同时存在多种线索」就成了偶然，改生成器时这条会挡一下。
    assert.match(report.stdout, /^SUMMARY \d+$/m)
    for (const field of ['name', 'email', 'amount']) assert.match(report.stdout, new RegExp(`^KIND ${field} [1-9]\\d*$`, 'm'))

    const initial = await fixture.evaluate()
    assert.equal(initial.passed, false)
    await fixture.applyReference()
    assert.equal((await fixture.evaluate()).passed, true)
  } finally { await fixture.close() }
})

test('the audit dataset and report generator are protected against rewriting', async () => {
  const fixture = await createFixture('audit')
  try {
    await fixture.applyReference()
    assert.equal((await fixture.evaluate()).passed, true)
    // 数据与报告生成器都在工作区里，模型改掉任一个都能让公开检查变成自己写的空断言。独立验收必须守住它们。
    for (const filename of ['data/records.jsonl', 'report.mjs', 'check.mjs']) {
      const original = await fs.readFile(path.join(fixture.workspace, filename))
      await fs.writeFile(path.join(fixture.workspace, filename), filename === 'data/records.jsonl' ? '' : "console.log('public checks passed')\n")
      const tampered = await fixture.evaluate()
      assert.equal(tampered.passed, false, `${filename} rewrite must be rejected`)
      assert.deepEqual(tampered.protectedFilesChanged, [filename])
      await fs.writeFile(path.join(fixture.workspace, filename), original)
    }
    assert.equal((await fixture.evaluate()).passed, true)
  } finally { await fixture.close() }
})

test('the sequence fixture declares its stages in file-name order and passes acceptance only as a whole', async () => {
  assert.ok(sequenceIds.length > 0)
  for (const id of sequenceIds) {
    const fixture = await createFixture(id)
    try {
      assert.ok(fixture.tasks.length > 1, `${id} must ship more than one stage`)
      // 阶段顺序由文件名前缀承载：每一阶段自己声明它是第几个，与目录项返回顺序无关。
      // 前缀是两位零填充，所以补零而不是拼一个 `0`——后者在第 10 阶段会拼出 `# 010 `，而正确的标题是
      // `# 10 `。这样写对 1～99 阶段都成立，不依赖「恰好不超过 9 个阶段」这个前提。
      fixture.tasks.forEach((task, at) => assert.match(task.split('\n')[0], new RegExp(`^# ${String(at + 1).padStart(2, '0')} `), `${id} stage ${at + 1}`))
      const initial = await fixture.evaluate()
      assert.equal(initial.passed, false)
      assert.equal(initial.exitCode, 1, initial.output)
      assert.match(initial.output, /AssertionError/)
      await fixture.applyReference()
      const reference = await fixture.evaluate()
      assert.equal(reference.passed, true, reference.output)
      assert.equal(reference.output.trim(), `acceptance passed: ${id}`)
    } finally { await fixture.close() }
  }
})

// 验收放宽之后必须能同时证明两件事，否则「放宽」会退化成「只要抛点东西就算过」：换成别的措辞、只要带
// 行号仍然通过；去掉行号则必须仍然失败。前者正是 NX-08e2 烟测里模型抛出的那条消息——它按 SPEC 实现了
// 行为，却因为私有断言钉了参考解恰好吐出的字符串而被判失败。
test('the sequence acceptance requires a line number instead of one exact error wording', async () => {
  const fixture = await createFixture('pipeline')
  try {
    await fixture.applyReference()
    // 带行号的错误消息现在由 plan-parse.mjs 的 failure 助手统一产出：第 7 阶段把「渲染文本 → 计划对象」
    // 的解析从 delta.mjs 抽了出去，diffPlan 的拒绝路径也改由它承担。改这一处即覆盖验收里那两条
    // rejectsWithLineNumber 用例。
    const parser = path.join(fixture.workspace, 'src', 'plan-parse.mjs')
    const reference = await fs.readFile(parser, 'utf8')
    const message = '`line ${line}: ${detail}`'
    const reworded = reference.replace(message, () => '`parse failed at line ${line}: ${detail}`')
    assert.notEqual(reworded, reference, 'the message under test must be the one the reference throws')
    await fs.writeFile(parser, reworded)
    assert.equal((await fixture.evaluate()).passed, true)
    await fs.writeFile(parser, reference.replace(message, () => '`${detail}`'))
    const noLineNumber = await fixture.evaluate()
    assert.equal(noLineNumber.passed, false)
    assert.match(noLineNumber.output, /expected a line number/)
  } finally { await fixture.close() }
})

// NX-08h 的仪器：pipeline 的十四阶段复制件，但工作区里**没有公开的 `check.mjs`**——任务说明不再给出那个
// 命令，只能按 `docs/SPEC.md` 自验。它把被测的问题从「有完整、即时、廉价 oracle 时能否收敛」换成「能否
// 按规格独立产出正确实现」，而 NX-08g0 判定的天花板正来自前者的 oracle。
//
// 这条用例守着的东西比别处更硬：方案 2 本身就是「改 fixture 契约」，没有第二道门禁看着它。因此除了基线，
// 还要钉住「与 pipeline 的差别只有公开检查这一件事」——差得更多，两次读数就不能并排比；差得更少（只删
// 文件不改说明），模型会去找一个不存在的命令。
test('the blind fixture drops the public check and stops pointing its stages at it', { timeout: 60_000 }, async () => {
  const fixture = await createFixture('blind')
  const other = await createFixture('pipeline')
  try {
    assert.equal(fixture.tasks.length, other.tasks.length, 'blind must ship exactly the stages pipeline ships')
    fixture.tasks.forEach((task, at) => assert.match(task.split('\n')[0], new RegExp(`^# ${String(at + 1).padStart(2, '0')} `), `blind stage ${at + 1}`))

    // 1. 工作区里没有公开检查，且模型看得见的内容一处都不提它。工作区是 initial/ 的整份复制，因此遍历它
    //    等价于遍历 initial/，不必自己去推算 fixture 目录的位置。
    const names = await fs.readdir(fixture.workspace, { recursive: true })
    const files: string[] = []
    for (const name of names) if ((await fs.stat(path.join(fixture.workspace, name))).isFile()) files.push(name)
    assert.ok(files.length, 'the workspace must not be empty')
    assert.ok(!files.includes('check.mjs'), 'blind must not ship a public check')
    for (const name of files) assert.doesNotMatch(await fs.readFile(path.join(fixture.workspace, name), 'utf8'), /check\.mjs/, `${name} must not mention the public check`)

    // 2. 阶段说明同样不提它，但仍然指得出权威——「按 SPEC 自验」只有在 SPEC 还被点到时才成立。
    fixture.tasks.forEach((task, at) => {
      assert.doesNotMatch(task, /check\.mjs/, `blind stage ${at + 1}`)
      assert.match(task, /docs\/SPEC\.md/, `blind stage ${at + 1} must still name the authority`)
    })

    // 3. 从 pipeline 去掉的每一行都必须与公开检查有关。只断言「不含 check.mjs」会放过一整段被改写的任务
    //    要求，而那样的改动会让这套仪器悄悄测起别的东西。
    other.tasks.forEach((stage, at) => {
      const kept = new Set(fixture.tasks[at].split('\n'))
      for (const line of stage.split('\n')) if (!kept.has(line)) assert.match(line, /check\.mjs|检查/, `stage ${at + 1} 改掉了一行与公开检查无关的内容：${line}`)
    })

    // 4. 两份验收器只差 marker 一行。marker 是 evaluate() 的逐字判定（`acceptance passed: <id>`），照抄
    //    pipeline 的那一行会让初始态与参考解双双验收失败。
    const pipelineVerify = await readFixtureFile('pipeline', 'verify.mjs')
    assert.equal(await readFixtureFile('blind', 'verify.mjs'), pipelineVerify.replace('acceptance passed: pipeline', 'acceptance passed: blind'))

    // 5. 基线：初始失败、参考通过，且终态判定与 marker 逐字相等。
    const initial = await fixture.evaluate()
    assert.equal(initial.passed, false)
    assert.equal(initial.exitCode, 1, initial.output)
    assert.match(initial.output, /AssertionError/)
    await fixture.applyReference()
    const reference = await fixture.evaluate()
    assert.equal(reference.passed, true, reference.output)
    assert.equal(reference.output.trim(), 'acceptance passed: blind')

    // 6. 没有公开检查之后，`docs/SPEC.md` 与 `data/` 成了工作区里唯一的规范载体，也更有动机被改动；它们
    //    必须仍在受保护集合里，否则某次失败可能来自「模型改了规格」，而不是「没有 oracle 就做不出来」。
    for (const filename of ['docs/SPEC.md', 'data/app.deps']) {
      const target = path.join(fixture.workspace, filename), original = await fs.readFile(target)
      await fs.writeFile(target, 'tampered\n')
      const tampered = await fixture.evaluate()
      assert.equal(tampered.passed, false, `${filename} rewrite must be rejected`)
      assert.deepEqual(tampered.protectedFilesChanged, [filename])
      await fs.writeFile(target, original)
    }
    assert.equal((await fixture.evaluate()).passed, true)
  } finally { await fixture.close(); await other.close() }
})

// 注册表互斥：blind 必须自成一档。并进 sequenceIds 会让 repeatCount(1, 2) 抛错，也会让对照 A 的两臂拿到
// 不同的任务集，把被比较的东西从上下文策略换成任务难度；并进 batchPhases 则会改变那条预注册的
// {18, 3_200, 88_000_000} 的含义。上面两条 otherBatches 断言原来只列了另外几档，blind 因此在跨批次上
// 是裸的——这条把它补上。
test('the blind fixture stays out of every other batch and owns a diagnostic phase', () => {
  assert.deepEqual([...blindIds], ['blind'])
  const others: readonly string[] = [...screeningIds, ...sequenceIds, ...boundedIds, ...demoIds]
  for (const id of blindIds) assert.ok(!others.includes(id), `${id} must stay out of the other four batches`)
  assert.ok(!(batchPhases as readonly string[]).includes('blind'), 'blind must not join the pre-registered batch phases')
  assert.deepEqual(phaseRegistry('blind'), ['blind'])
})

async function runFixtureAcrossBudgetStop(id: FixtureId) {
  const fixture = await createFixture(id), root = new Context()
  try {
    for (const plugin of [sessions, systemPrompt, tools, llm, agents, agentLoop]) await root.plugin(plugin)
    await root.plugin(sandbox, { workspace: fixture.workspace, autoApprove: true })
    await root.plugin(files); await root.plugin(bash)
    const commands: ToolCall[] = [
      { id: 'inspect-source', name: 'read_file', arguments: { path: fixture.edits[0].path } },
      { id: 'failed-check', name: 'bash', arguments: { command: 'node check.mjs' } },
      { id: 'deferred-fix', name: 'edit_file', arguments: fixture.edits[0] },
      ...fixture.edits.map((edit, index) => ({ id: `fix-${index}`, name: 'edit_file', arguments: edit })),
      { id: 'passing-check', name: 'bash', arguments: { command: 'node check.mjs' } },
    ]
    let step = 0
    root.llm.register('continuation', { models: ['fixture'], chat: async ({ messages = [] }) => {
      assertToolProtocol(messages)
      const previous = commands[step - 1]
      if (previous) {
        const result = messages.at(-1)!
        assert.equal(result.role, 'tool')
        assert.equal(result.tool_call_id, previous.id)
        if (previous.name === 'bash') {
          assert.doesNotMatch(result.content ?? '', /ToolError:/)
          const check = JSON.parse(result.content ?? '{}')
          assert.equal(check.exitCode, previous.id === 'passing-check' ? 0 : 1)
        } else if (previous.id === 'deferred-fix') assert.match(result.content ?? '', /skipped after max_steps/)
        else assert.doesNotMatch(result.content ?? '', /ToolError:/)
      }
      return step < commands.length ? { toolCalls: [commands[step++]] } : { content: 'continued fixture finished' }
    } })
    const session = root.sessions.create({ source: 'coding-fixture-continuation', fixtureId: id })
    const agent = root.agents.create({ sessionId: session.id, model: 'continuation/fixture', loop: root.agentLoop,
      budget: { maxModelRequests: 3, maxToolCalls: 8, maxActiveDurationMs: 20_000 } })
    await assert.rejects(agent.send(fixture.tasks[0]), /max_steps/)
    const stopped = root.sessions.latestRun(session.id)!
    assert.equal(stopped.status, 'max_steps')
    assert.equal(step, 3)
    assert.equal((await fixture.evaluate()).passed, false)
    const beforeResults = session.events.filter(e => e.type === 'tool/result')
    assert.equal(beforeResults.length, 3)
    assert.equal(beforeResults.find(e => e.data.toolCallId === 'deferred-fix')?.data.status, 'skipped')
    agent.budget = { maxModelRequests: 8, maxToolCalls: 8, maxActiveDurationMs: 20_000 }
    assert.equal(await agent.continue(), 'continued fixture finished')
    assert.equal(root.sessions.latestRun(session.id)?.status, 'completed')
    assert.equal((await fixture.evaluate()).passed, true)
    assert.equal(root.sessions.taskState(session.id, stopped.taskId).continuations, 1)
    const results = session.events.filter(e => e.type === 'tool/result')
    assert.equal(results.length, commands.length)
    assert.equal(results.filter(e => e.data.toolCallId === 'inspect-source').length, 1)
    assert.equal(results.filter(e => e.data.toolCallId === 'failed-check').length, 1)
    assertToolProtocol(root.sessions.deriveMessages(session.id))
  } finally { await root.fiber.dispose(); await fixture.close() }
}

test('fixture continuation driver stops at request budget and resumes one task without repeating tools', { timeout: 30_000 }, async () => {
  await runFixtureAcrossBudgetStop('boundary')
})

test('dedupe task survives budget stop and continues without repeating completed checks', { timeout: 30_000 }, async () => {
  await runFixtureAcrossBudgetStop('dedupe')
})

test('retry task resumes after budget stop without replaying completed tools', { timeout: 30_000 }, async () => {
  await runFixtureAcrossBudgetStop('retry')
})

test('summary task resumes after budget stop and keeps the prior failed check', { timeout: 30_000 }, async () => {
  await runFixtureAcrossBudgetStop('summary')
})

test('acceptance bounds hung code and output, rejects invalid limits and reports infrastructure failure', async () => {
  const fixture = await createFixture('boundary')
  try {
    await assert.rejects(fixture.evaluate({ timeoutMs: 0 }), /invalid acceptance limits/)
    await fs.writeFile(path.join(fixture.workspace, 'src/index.mjs'), 'while (true) {}\n')
    const hung = await fixture.evaluate({ timeoutMs: 200 })
    assert.equal(hung.passed, false)
    assert.equal(hung.exitCode, null)
    assert.match(hung.output, /ETIMEDOUT/)
    await fs.writeFile(path.join(fixture.workspace, 'src/index.mjs'), "process.stdout.write('x'.repeat(100000)); process.exit(0)\n")
    const noisy = await fixture.evaluate({ maxOutputBytes: 1024 })
    assert.equal(noisy.passed, false)
    assert.match(noisy.output, /ENOBUFS/)
    assert.ok(Buffer.byteLength(noisy.output) <= 1024)
  } finally { await fixture.close() }
})

// 演示夹具。它比其他 14 个多一份 `partial/` ——「只修好第一条规则」的已知中间态，供 NX-10-3 展示
// 「失败测试 → 再修复」。那一步成立的前提是这份中间态**真的**过不了公开检查、且失败输出改点名第二条
// 规则，因此把它钉在这里，而不是让演示脚本自述。
// 它必须不属于另外三批：进筛查批次会动 NX-08d 的 12/12 与 phaseCaps.screening.runs，进阶段序列会被
// 当成多阶段 fixture，进对照 B 仪器则会让那台仪器的「单任务」契约不再唯一。
test('the repair fixture keeps a partial fix that still fails the public check', { timeout: 30_000 }, async () => {
  assert.deepEqual([...demoIds], ['repair'])
  const otherBatches: readonly string[] = [...screeningIds, ...sequenceIds, ...boundedIds, ...blindIds]
  for (const id of demoIds) assert.ok(!otherBatches.includes(id), `${id} must stay out of the other four batches`)
  const fixture = await createFixture('repair')
  try {
    assert.equal(fixture.tasks.length, 1, 'the demo fixture works in a single task')
    // 规则分布在两个作用域，公开检查的失败消息各自点名被违反的那一条——演示因此可归因而非笼统报错。
    const runCheck = () => spawnSync(process.execPath, ['check.mjs'], { cwd: fixture.workspace, encoding: 'utf8', timeout: fixtureProcessTimeoutMs, windowsHide: true })

    const initial = runCheck()
    assert.equal(initial.status, 1)
    assert.match(initial.stderr, /单项折扣应按行金额在求和前应用/)

    // 中间态：第一条规则修好、第二条没修。检查仍失败，且失败消息换成第二条——两条规则互不遮蔽。
    await fs.writeFile(path.join(fixture.workspace, 'src/cart.mjs'), await readFixtureFile('repair', 'partial/src/cart.mjs'))
    const partial = runCheck()
    assert.equal(partial.status, 1)
    assert.match(partial.stderr, /percentOff 是整数百分数/)
    assert.doesNotMatch(partial.stderr, /单项折扣应按行金额在求和前应用/)
    assert.equal((await fixture.evaluate()).passed, false)

    // 只有完整参考解通过。上一步已经动过工作区，这里直接在同一个工作区上覆盖。
    await fixture.applyReference()
    assert.equal((await fixture.evaluate()).passed, true)

    // 受保护边界：两份 AGENTS.md、公开检查与旧副本都不在 sources.repair 内。逐个改写并确认被判成变更，
    // 同时确认「有一条受保护文件被改」本身就足以让验收不通过。
    for (const relative of ['AGENTS.md', 'src/AGENTS.md', 'check.mjs', 'src/legacy/cart.mjs']) {
      const original = await fs.readFile(path.join(fixture.workspace, relative))
      await fs.writeFile(path.join(fixture.workspace, relative), 'tampered\n')
      const tampered = await fixture.evaluate()
      assert.equal(tampered.passed, false, `${relative} must not be editable`)
      assert.deepEqual(tampered.protectedFilesChanged, [relative])
      await fs.writeFile(path.join(fixture.workspace, relative), original)
    }

    // 越界读取被拒：readFixtureFile 只服务 fixture 目录内部。
    await assert.rejects(readFixtureFile('repair', '../boundary/initial/check.mjs'), /escapes the fixture directory/)
  } finally { await fixture.close() }
})
