import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFixture, fixtureIds, fixtureKind, comprehensionIds, mutationIds, screeningIds, sequenceIds, boundedIds, demoIds, blindIds, ledgerIds } from '../scripts/coding-fixtures.js'
import type { FixtureId } from '../scripts/coding-fixtures.js'
import { runFixtureTask, scriptedAdapter } from '../scripts/eval-fixture.js'

// NX-39 新增两个种类的**门禁**：它们判的是别的东西（产物运行起来对不对，而不是工作区终态长什么样），
// 所以既有的那套前提自检覆盖不到它们的失效方式。「判据有分辨力」是这些用例要钉的唯一一件事。
const repository = fileURLToPath(new URL('../../', import.meta.url))
const codingFixtures = path.join(repository, 'test', 'fixtures', 'coding')
// 判据的载荷与隐藏件只允许住在这些名字下；它们一旦出现在 initial/ 或任务文本里，判据就可以由工作区
// 推导出来（R-23），而 fixture 看起来仍然一切正常。
const HIDDEN = ['reference', 'oracle', 'weak', 'mutants', 'equivalents']
const newKindIds = (): FixtureId[] => [...comprehensionIds, ...mutationIds] as FixtureId[]

// 逐行最长公共子序列的行走，把差异行并成「几处改动」。只数处数，不做通用 diff 排版——这里要回答的
// 唯一问题是「initial 与 reference 差了几处」。
function countHunks(before: readonly string[], after: readonly string[]): number {
  const lcs: number[][] = Array.from({ length: before.length + 1 }, () => new Array<number>(after.length + 1).fill(0))
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) lcs[i]![j] = before[i] === after[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
  }
  const script: ('same' | 'change')[] = []
  let [i, j] = [0, 0]
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) { script.push('same'); i += 1; j += 1 }
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) { script.push('change'); i += 1 }
    else { script.push('change'); j += 1 }
  }
  for (; i < before.length; i += 1) script.push('change')
  for (; j < after.length; j += 1) script.push('change')
  return script.filter((op, index) => op === 'change' && script[index - 1] !== 'change').length
}
// 按 LF 归一后再比：本仓库 core.autocrlf 生效，不归一会让同一份文件在 Windows 检出后得到另一个结论。
const lines = (text: string) => text.replace(/\r\n/g, '\n').split('\n')
const read = (relative: string) => fs.readFile(path.join(repository, relative), 'utf8')

async function walk(directory: string, prefix = ''): Promise<string[]> {
  const found: string[] = []
  for (const entry of await fs.readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name)
    if (entry.isDirectory()) found.push(...await walk(directory, relative))
    else found.push(relative)
  }
  return found
}

test('a new-kind fixture puts only the artifact into the workspace and never the reference sources', async () => {
  // 这条曾经写错过一版：applyReference 把整棵 reference/ 覆盖进工作区之后，agent 的产物在**缺陷**上
  // 也照样通过，判据当场失效且毫无征兆（fixtures:check 那次报的是 reference 态 initialExitCode=0）。
  const fixture = await createFixture('repro-sessions')
  try {
    assert.equal(fixture.kind, 'repro')
    const defect = await read('test/fixtures/coding/repro-sessions/initial/src/sessions.mjs')
    assert.equal(await fs.readFile(path.join(fixture.workspace, 'src/sessions.mjs'), 'utf8'), defect)
    await fixture.applyReference()
    assert.equal(await fs.readFile(path.join(fixture.workspace, 'src/sessions.mjs'), 'utf8'), defect)
    assert.equal(await fs.readFile(path.join(fixture.workspace, fixture.artifact!.path), 'utf8'), fixture.artifact!.content)
  } finally { await fixture.close() }
})

test('every comprehension fixture states exactly one defect and ships a non-vacuous negative control', async () => {
  for (const id of comprehensionIds) {
    const source = path.join(codingFixtures, id)
    const changed = (await walk(path.join(source, 'initial'))).filter(relative => relative.startsWith('src/'))
    assert.ok(changed.length > 0, `${id} must ship source files`)
    // 「一模块一缺陷」是 FAIL_TO_PASS 成立的前提：差得多于一处的 fixture 上，产物的失败可能来自别的
    // 改动，判据就不再对应「读懂这一处」。
    for (const relative of changed) {
      const before = lines(await fs.readFile(path.join(source, 'initial', relative), 'utf8'))
      const after = lines(await fs.readFile(path.join(source, 'reference', relative), 'utf8'))
      assert.equal(countHunks(before, after), 1, `${id}/${relative} must differ by exactly one hunk`)
    }
    const criteria: unknown = JSON.parse(await fs.readFile(path.join(source, 'criteria.json'), 'utf8'))
    const artifact = (criteria as { artifact: string }).artifact
    // 反例产物若与参考产物逐字相同，这道门禁就是空的。
    assert.notEqual(await fs.readFile(path.join(source, 'weak', artifact), 'utf8'), await fs.readFile(path.join(source, 'oracle', artifact), 'utf8'),
      `${id}: the weak artifact must differ from the oracle`)
  }
})

test('hidden criteria payloads stay out of the workspace and out of every task text', async () => {
  // R-23：判据与产生它的仪表都不能在工作区里，也不可由工作区推导。新种类的隐藏件比 edit 种类多
  // （oracle/ 与 weak/ 各是一份完整产物），漏一个就等于把答案抄给了模型。
  for (const id of newKindIds()) {
    const source = path.join(codingFixtures, id)
    const visible = [...(await walk(path.join(source, 'initial'))).map(relative => path.join('initial', relative)), 'TASK.md']
    for (const relative of visible) {
      const text = await fs.readFile(path.join(source, relative), 'utf8')
      for (const name of HIDDEN) assert.doesNotMatch(text, new RegExp(name), `${id}/${relative} must not name ${name}`)
    }
    // 产物必须由 agent **新建**：它若已经在 initial/ 里，可改文件为空的这一类就变成「改一个文件」了。
    const criteria: unknown = JSON.parse(await fs.readFile(path.join(source, 'criteria.json'), 'utf8'))
    const artifact = (criteria as { artifact: string }).artifact
    assert.ok(!(await walk(path.join(source, 'initial'))).includes(artifact), `${id}/${artifact} must not exist in initial/`)
    assert.equal(fixtureKind(id), (criteria as { kind: string }).kind, `${id}: criteria.json and the registry must agree`)
  }
})

test('the scripted model drives a comprehension fixture through write_file to a passing acceptance', { timeout: 60_000 }, async () => {
  // 新种类的产物是**新建**的文件，走 write_file 而不是 edit_file；这条钉住评测链路真的能驱动它，
  // 而不只是 fixtures:check 那条直连验收器的路径能跑通。
  const outcome = await runFixtureTask('repro-sessions', scriptedAdapter)
  assert.equal(outcome.accepted, true)
  assert.equal(outcome.acceptance?.exitCode, 0)
  assert.equal(outcome.acceptance?.evidence?.kind, 'repro')
  assert.deepEqual(outcome.acceptance?.protectedFilesChanged, [])
})

test('the two new registries stay out of every other batch', () => {
  // 与 blind／ledger 同一条理由：并进筛查批次会动 NX-08d 的 12/12 与它的上限；并进 sequenceIds 会让
  // 对照 A 的两臂拿到不同的任务集，把被比较的东西从「上下文策略」换成「任务难度」。
  assert.deepEqual(newKindIds(), [...comprehensionIds])
  const others: readonly string[] = [...screeningIds, ...sequenceIds, ...boundedIds, ...demoIds, ...blindIds, ...ledgerIds]
  for (const id of newKindIds()) {
    assert.ok(!others.includes(id), `${id} must stay out of the other six batches`)
    assert.equal(fixtureIds.filter(candidate => candidate === id).length, 1)
  }
  // 互斥要两个方向都成立：新注册表里也不能混进既有 id。
  for (const id of others) assert.ok(!newKindIds().includes(id as FixtureId), `${id} must not join the new registries`)
})
