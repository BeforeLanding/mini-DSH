import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createFixture, fixtureCategory, fixtureIds, fixtureKind, comprehensionIds, mutationIds, screeningIds, sequenceIds, boundedIds, demoIds, blindIds, ledgerIds } from '../scripts/coding-fixtures.js'
import type { Acceptance, FixtureId, MutationEvidence } from '../scripts/coding-fixtures.js'
import { runFixtureTask, scriptedAdapter } from '../scripts/eval-fixture.js'

// NX-39 新增两个种类的**门禁**：它们判的是别的东西（产物运行起来对不对，而不是工作区终态长什么样），
// 所以既有的那套前提自检覆盖不到它们的失效方式。「判据有分辨力」是这些用例要钉的唯一一件事。
const repository = fileURLToPath(new URL('../../', import.meta.url))
const codingFixtures = path.join(repository, 'test', 'fixtures', 'coding')
// 判据的载荷与隐藏件只允许住在这些名字下；它们一旦出现在 initial/ 或任务文本里，判据就可以由工作区
// 推导出来（R-23），而 fixture 看起来仍然一切正常。
const HIDDEN = ['reference', 'oracle', 'weak', 'mutants', 'equivalents']
const newKindIds = (): FixtureId[] => [...comprehensionIds, ...mutationIds] as FixtureId[]
// 重构类按**类别**取，不写死那两个 id：类别是报告口径的一部分，重排注册表或调整分类时这条门禁要跟着走，
// 而不是继续守着一对不再属于重构的 fixture。
const refactorIds = (): FixtureId[] => fixtureIds.filter(id => fixtureCategory(id) === 'refactor')

// 逐行最长公共子序列的行走，把差异行并成「几处改动」。只数处数，不做通用 diff 排版——这里要回答的
// 唯一问题是「两份源码差了几处」。
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

// 具名导出面：只认 `export function`／`const`／`let`／`class` 这几种写法，三个种类的工作区模块都长这样。
// 变异体与等价体都必须在**逐字相同**的导出面上工作，否则「杀掉的变异体」可能只是「换个名字调不通」。
function exportsOf(code: string): string[] {
  return [...code.replace(/\r\n/g, '\n').matchAll(/^export\s+(?:async\s+)?(?:function|const|let|class)\s+(\w+)/gm)].map(match => match[1]!).sort()
}

function mutationEvidence(id: FixtureId, acceptance: Acceptance): MutationEvidence {
  const evidence = acceptance.evidence
  if (evidence === undefined || evidence.kind !== 'mutation') throw new Error(`${id} must report mutation evidence, got ${String(evidence?.kind)}`)
  return evidence
}

test('a new-kind fixture puts only the artifact into the workspace and never the reference sources', async () => {
  // 这条曾经写错过一版：applyReference 把整棵 reference/ 覆盖进工作区之后，agent 的产物在**缺陷**上
  // 也照样通过，判据当场失效且毫无征兆（fixtures:check 那次报的是 reference 态 initialExitCode=0）。
  for (const id of newKindIds()) {
    const fixture = await createFixture(id)
    try {
      assert.equal(fixture.kind, fixtureKind(id))
      // 两类都只有一处可改的源码，因此「参考态」就是源码那一处不动、产物多出来一份。
      const [source] = (await walk(path.join(codingFixtures, id, 'initial'))).filter(relative => relative.startsWith('src/'))
      assert.ok(source, `${id} must ship a source file`)
      const shipped = await read(`test/fixtures/coding/${id}/initial/${source}`)
      assert.equal(await fs.readFile(path.join(fixture.workspace, source), 'utf8'), shipped)
      await fixture.applyReference()
      assert.equal(await fs.readFile(path.join(fixture.workspace, source), 'utf8'), shipped)
      assert.equal(await fs.readFile(path.join(fixture.workspace, fixture.artifact!.path), 'utf8'), fixture.artifact!.content)
    } finally { await fixture.close() }
  }
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

test('every mutation fixture ships one-hunk mutants and full rewrites that keep the export surface', async () => {
  for (const id of mutationIds) {
    const source = path.join(codingFixtures, id)
    const modules = (await walk(path.join(source, 'initial'))).filter(relative => relative.startsWith('src/'))
    assert.equal(modules.length, 1, `${id} must ship exactly one source module`)
    const module = modules[0]!
    const original = await fs.readFile(path.join(source, 'initial', module), 'utf8')
    const exported = exportsOf(original)
    assert.ok(exported.length > 0, `${id} must export a function`)
    const initialFiles = await walk(path.join(source, 'initial'))
    // 变异体：只改一处、只改一行、导出面逐字不变。「一模块一变异」是变异得分成立的前提——改动多于一处的
    // 变异体可能被「别的改动」杀掉，读数就不再对应这一处；导出面变了则说明它不是同一道题的另一种写法。
    const mutants = (await fs.readdir(path.join(source, 'mutants'))).sort()
    assert.ok(mutants.length >= 2, `${id} needs at least two mutants to make a threshold meaningful`)
    for (const name of mutants) {
      const changed = await walk(path.join(source, 'mutants', name))
      assert.equal(changed.length, 1, `${id}/mutants/${name} must touch exactly one file`)
      assert.ok(initialFiles.includes(changed[0]!), `${id}/mutants/${name}/${changed[0]} must overlay a file that exists in initial/`)
      const text = await fs.readFile(path.join(source, 'mutants', name, changed[0]!), 'utf8')
      assert.deepEqual(exportsOf(text), exported, `${id}/mutants/${name} must keep the export surface`)
      assert.equal(countHunks(lines(original), lines(text)), 1, `${id}/mutants/${name} must differ by exactly one hunk`)
    }
    // 等价体反过来必须是**整文件重写**：只改一两处的「等价体」挡不住比对源码文本的产物，因为它与原文
    // 的差别太小、太像一次针对性的规避，一个按行号或按片段匹配的套件反而可能蒙混过关。
    const equivalents = (await fs.readdir(path.join(source, 'equivalents'))).sort()
    assert.ok(equivalents.length >= 1, `${id} needs at least one equivalent`)
    for (const name of equivalents) {
      const changed = await walk(path.join(source, 'equivalents', name))
      assert.equal(changed.length, 1, `${id}/equivalents/${name} must rewrite exactly one file`)
      const text = await fs.readFile(path.join(source, 'equivalents', name, changed[0]!), 'utf8')
      assert.deepEqual(exportsOf(text), exported, `${id}/equivalents/${name} must keep the export surface`)
      assert.ok(countHunks(lines(original), lines(text)) >= 2, `${id}/equivalents/${name} must be a rewrite, not a one-line tweak`)
    }
  }
})

test('the public check of every mutation fixture kills fewer mutants than the fixture requires', { timeout: 120_000 }, async () => {
  // 这是唯一能机械证明「阈值不是白送的」的方式：只说「参考套件杀够了」的话，一个把 minKilled 定成 1 的
  // fixture 也能全绿。要钉住的是「交到 agent 手上的那一级**不够**」。
  for (const id of mutationIds) {
    const fixture = await createFixture(id)
    try {
      const minKilled = fixture.minKilled
      if (minKilled === undefined) throw new Error(`${id} must declare a minKilled`)
      const artifact = fixture.artifact!.path
      // 反例必须**就是**工作区里那份公开检查（`check.mjs`）。换成另一份「精心做弱」的套件，这条门禁量的
      // 就不再是「交给 agent 的那一级够不够」，而是一个没人见过的稻草人。
      assert.equal(await read(`test/fixtures/coding/${id}/weak/${artifact}`), await read(`test/fixtures/coding/${id}/initial/check.mjs`), `${id}: the weak control must be the public check`)
      await fs.writeFile(path.join(fixture.workspace, artifact), await read(`test/fixtures/coding/${id}/weak/${artifact}`))
      const weak = await fixture.evaluate()
      const evidence = mutationEvidence(id, weak)
      assert.equal(evidence.originalExitCode, 0, `${id}: the public check must be green on the correct sources`)
      assert.equal(evidence.equivalentsKilled, 0, `${id}: the public check must not kill an equivalent`)
      assert.ok(evidence.mutantsKilled < minKilled, `${id}: the public check killed ${evidence.mutantsKilled} mutant(s), which is not fewer than ${minKilled}`)
      assert.equal(weak.passed, false, `${id}: the public check must not be accepted`)
    } finally { await fixture.close() }
  }
})

test('hidden criteria payloads stay out of the workspace and out of every task text', async () => {
  // R-23：判据与产生它的仪表都不能在工作区里，也不可由工作区推导。新种类的隐藏件比 edit 种类多
  // （oracle/ 、weak/、mutants/、equivalents/ 各是一份完整的源码或产物），漏一个就等于把答案抄给了模型。
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

test('every new-kind fixture tells the agent the same names the fixture is wired to', async () => {
  // 这些 fixture 是从同一个模板复制出来的，因此最可能的失效不是判据退化了，而是**复制时改漏一处**：
  // TASK.md 让 agent 去 import 上一个 fixture 的模块、或去新建另一个名字的产物。那时判据照常工作、
  // fixtures:check 照常全绿——只是它判的那份东西没人交得出来，要等真跑模型才会发现。
  for (const id of newKindIds()) {
    const source = path.join(codingFixtures, id)
    const task = await fs.readFile(path.join(source, 'TASK.md'), 'utf8')
    const criteria: unknown = JSON.parse(await fs.readFile(path.join(source, 'criteria.json'), 'utf8'))
    const artifact = (criteria as { artifact: string }).artifact
    assert.match(task, new RegExp(artifact.replace('.', '\\.')), `${id}: TASK.md must name the artifact ${artifact}`)
    const modules = (await walk(path.join(source, 'initial'))).filter(relative => relative.startsWith('src/'))
    assert.equal(modules.length, 1, `${id} must ship exactly one source module`)
    const exported = exportsOf(await fs.readFile(path.join(source, 'initial', modules[0]!), 'utf8'))
    assert.ok(exported.length > 0, `${id} must export a function`)
    for (const name of exported) assert.match(task, new RegExp(`\\b${name}\\b`), `${id}: TASK.md must name the export ${name}`)
    // mutation 的约定更强一层：阈值必须写在任务说明里，否则 agent 无从知道要杀几个。
    const minKilled = (criteria as { minKilled?: number }).minKilled
    if (minKilled !== undefined) assert.match(task, new RegExp(`\\b${minKilled}\\b`), `${id}: TASK.md must state the threshold ${minKilled}`)
  }
})

test('the scripted model drives every new-kind fixture through write_file to a passing acceptance', { timeout: 120_000 }, async () => {
  // 新种类的产物是**新建**的文件，走 write_file 而不是 edit_file；这条钉住评测链路真的能驱动它，
  // 而不只是 fixtures:check 那条直连验收器的路径能跑通。逐 fixture 跑而不是只跑一个：模板复制出来的
  // 东西最容易在「复制时改漏一处」上失效，那种失配在每个 fixture 上各自表现一次，只跑一个会漏掉其余几个。
  // 对 mutation 这一类，这条同时是**逐 fixture 的「参考套件杀数 ≥ minKilled 且不杀等价体」的证明**——
  // 验收本身就要求复算出的 evidencePasses 成立，而它要求 mutantsKilled >= minKilled。
  for (const id of newKindIds()) {
    const outcome = await runFixtureTask(id, scriptedAdapter)
    assert.equal(outcome.accepted, true, `${id} must be accepted when the reference artifact is written`)
    assert.equal(outcome.acceptance?.exitCode, 0, `${id} acceptance must exit 0`)
    assert.equal(outcome.acceptance?.evidence?.kind, fixtureKind(id), `${id} must report ${fixtureKind(id)} evidence`)
    assert.deepEqual(outcome.acceptance?.protectedFilesChanged, [], `${id} must not touch protected files`)
  }
})

test('the two new registries stay out of every other batch', () => {
  // 与 blind／ledger 同一条理由：并进筛查批次会动 NX-08d 的 12/12 与它的上限；并进 sequenceIds 会让
  // 对照 A 的两臂拿到不同的任务集，把被比较的东西从「上下文策略」换成「任务难度」。
  assert.deepEqual(newKindIds(), [...comprehensionIds, ...mutationIds])
  const others: readonly string[] = [...screeningIds, ...sequenceIds, ...boundedIds, ...demoIds, ...blindIds, ...ledgerIds]
  for (const id of newKindIds()) {
    assert.ok(!others.includes(id), `${id} must stay out of the other six batches`)
    assert.equal(fixtureIds.filter(candidate => candidate === id).length, 1)
  }
  // 互斥要两个方向都成立：新注册表里也不能混进既有 id。
  for (const id of others) assert.ok(!newKindIds().includes(id as FixtureId), `${id} must not join the new registries`)
})

// 重构类的判据分两段，两段成立的**条件不同**：段 1（行为不变）问「有没有动到不该动的地方」，它对改动的
// **前后**两份实现都成立；段 2（新接口）问「点名要改的那两处改了没有」，它只在参考态成立。两段若写混，
// 初始态判不过的原因就不再唯一——「行为被改坏了」与「改动还没做完」给出同一个读数，而报告里前者是失败、
// 后者只是没完成。下面这条钉的就是这个分离。
test('a refactor fixture fails on its original sources for the interface alone, never for its behaviour', () => {
  const ids = refactorIds()
  // 类别为空时这条门禁会「全绿」——它守的东西一个都没守到。
  assert.ok(ids.length > 0, '重构类至少要有一个 fixture')
  for (const id of ids) {
    const source = path.join(codingFixtures, id)
    const result = spawnSync(process.execPath, [path.join(source, 'verify.mjs'), path.join(source, 'initial')], { encoding: 'utf8' })
    assert.equal(result.status, 1, `${id}: 改动前的那份源码必须判不过`)
    assert.match(result.stderr, /新接口/, `${id}: 判不过的理由应当是「新接口还没改」，实际是 ${result.stderr.trim().slice(0, 200)}`)
    assert.doesNotMatch(result.stderr, /行为不变/, `${id}: 「行为不变」那一段对改动前的源码也必须成立`)
  }
})

test('a refactor fixture rejects the new shape when the numbers behind it are wrong', async () => {
  // 两个反例，各自堵一条「判据白送」的路子：
  //   ① 形状对、数整体算错——公开检查、返回形状、渲染文本可以全绿，只有与**改动前的那份实现**对照才看得出来。
  //   ② 只在手写的那几条上算对、在别处算错——这一条钉住「输入空间是由生成出来的那一片撑着」。把生成那块
  //      删掉、只留手写的几条，①照样判红（它在手写用例上就错），②会当场变成全绿。
  // 两个反例还共同钉住参照物的**来源**：它必须来自工作区之外。若 `loadPristine` 改从工作区读，就成了拿
  // 候选跟它自己比，两条都会变绿。
  const broken = {
    '数整体算错': "export function calculateSubtotal(items) {\n  return { amount: items.reduce((sum, item) => sum + item.price * item.quantity, 0) + 0.01, currency: 'CNY' }\n}\n",
    '只在前四条上算对': "export function calculateSubtotal(items) {\n  if (items.length > 3) return { amount: 0, currency: 'CNY' }\n  return { amount: items.reduce((sum, item) => sum + item.price * item.quantity, 0), currency: 'CNY' }\n}\n",
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nx39-refactor-'))
  const workspace = path.join(directory, 'workspace')
  try {
    // 候选的工作区是**参考态**、只把 `pricing.mjs` 换掉——反例要只错在一处。若留着初始态的 `receipt.mjs`，
    // 它会在调用方就抛 `TypeError`，判红的原因就不是「数算错了」，这条门禁会以为自己守住了其实没有。
    await fs.cp(path.join(codingFixtures, 'interface', 'initial'), workspace, { recursive: true })
    await fs.cp(path.join(codingFixtures, 'interface', 'reference', 'src'), path.join(workspace, 'src'), { recursive: true })
    for (const [label, source] of Object.entries(broken)) {
      await fs.writeFile(path.join(workspace, 'src', 'pricing.mjs'), source)
      const result = spawnSync(process.execPath, [path.join(codingFixtures, 'interface', 'verify.mjs'), workspace], { encoding: 'utf8' })
      assert.equal(result.status, 1, `${label}：候选必须判不过`)
      assert.match(result.stderr, /行为不变/, `${label}：判不过的理由应当落在「行为不变」上，实际是 ${result.stderr.trim().slice(0, 200)}`)
    }
  } finally {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()))
    await fs.rm(directory, { recursive: true, force: true })
  }
})
