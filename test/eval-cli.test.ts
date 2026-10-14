import test from 'node:test'
import assert from 'node:assert/strict'
import { derivePruningTarget, evidenceScope, ledgerRunPeaks, parseEvalArguments, phaseRegistry, repeatCount, resolveContextWindow, resolveInfeasible, resolveInputTarget, resolveModel, resolvePlanned, resolveRuns } from '../scripts/eval-cli.js'
import { ablationPhases, ledgerPhases, phaseCaps } from '../scripts/eval-runner.js'
import type { PhaseName } from '../scripts/eval-runner.js'
import { ablationIds, ledgerIds, screeningIds, sequenceIds } from '../scripts/coding-fixtures.js'

// 入口脚本本身有顶层 await（协议探测、付费批次），被 import 就会花钱，所以真实的参数与计划判据全部
// 住在 eval-cli.ts 的纯函数里，由这里离线钉住。

test('the default plan is the phase registry, not every known fixture', () => {
  // 不带 --tasks 时曾经返回全部 fixtureIds（NX-08e1-1 拆注册表后是 13 项），而 screening 的上限是 12
  // 次运行：第 13 个计划任务永远不会被调度，「跑了 12 个」会被读成「筛出了 12 个」。
  assert.deepEqual(resolvePlanned('screening'), [...screeningIds])
  assert.equal(resolvePlanned('screening').length, 12)
  assert.deepEqual(resolvePlanned('sequence'), ['pipeline'])
  assert.equal(resolvePlanned('sequence').length, sequenceIds.length)
  assert.equal(evidenceScope('screening', resolvePlanned('screening')), 'full')
  assert.equal(evidenceScope('sequence', resolvePlanned('sequence')), 'full')
})

test('a partial selection names its own evidence scope instead of passing as a whole batch', () => {
  assert.equal(evidenceScope('screening', resolvePlanned('screening', 'boundary,merge')), 'boundary-merge')
  // 顺序不同不算整批：目录名是给人看的，改写顺序会落进不同的目录，本来就该分开。
  assert.equal(evidenceScope('screening', ['merge', 'boundary']), 'merge-boundary')
})

// 跨阶段取任务是这次要堵死的陷阱：它让 --tasks pipeline 落在 screening 阶段，套错 phase 标签与上限。
test('--tasks cannot reach outside the selected phase', () => {
  assert.throws(() => resolvePlanned('screening', 'pipeline'), /outside the screening phase: pipeline/)
  assert.throws(() => resolvePlanned('sequence', 'boundary'), /outside the sequence phase: boundary/)
  assert.deepEqual(resolvePlanned('screening', ' boundary , merge '), ['boundary', 'merge'])
  assert.throws(() => resolvePlanned('screening', 'boundary,boundary'), /duplicate fixture ids/)
  assert.throws(() => resolvePlanned('screening', ','), /--tasks must name fixture ids/)
})

// 两臂跑同一份任务集是刻意的：对照 A 比较的是上下文策略，不是任务难度；臂间差异只由 eval-runner 的
// armPolicy 承担（输入目标），因此这里必须相等。
test('both comparison arms plan the same sequence task set', () => {
  assert.deepEqual(phaseRegistry('armA'), ['pipeline'])
  assert.deepEqual(resolvePlanned('armB'), ['pipeline'])
  assert.equal(evidenceScope('armA', resolvePlanned('armA')), 'full')
  assert.equal(phaseRegistry('armA').length, sequenceIds.length)
})

// NX-08e 的事故：armA/armB 的 phaseCaps.runs = 3 当时只被 overCap 当中止阈值用，入口没有任何产生重复
// 的机制（runPhase 遍历的是 registry 那 1 个 fixture），于是「每臂 3 次运行」的预注册一条命令只兑现 1 次；
// --plan-only 还把上限当计划打印，让它在花钱之前看不出破绽。这条断言把两者钉死在一起，是当时缺的那一环。
test('every phase schedules exactly as many runs as its cap pre-registers', () => {
  const phases: readonly PhaseName[] = ['screening', 'armA', 'armB', 'sequence', 'smoke', 'blind', ...ledgerPhases, ...ablationPhases]
  for (const phase of phases) assert.equal(resolveRuns(phase).length, phaseCaps[phase].runs, phase)
  // 两臂的差异只能来自上下文策略，不能来自跑了几次或跑了哪些任务，因此执行清单必须逐字相同。
  assert.deepEqual(resolveRuns('armA'), resolveRuns('armB'))
  assert.deepEqual(resolveRuns('armA'), [
    { id: 'pipeline', repeat: 0 },
    { id: 'pipeline', repeat: 1 },
    { id: 'pipeline', repeat: 2 },
  ])
  assert.deepEqual(resolveRuns('sequence'), [{ id: 'pipeline', repeat: 0 }])
  // blind 是单 fixture 的诊断烟测：一次运行，且不借用 pipeline 的清单。
  assert.deepEqual(resolveRuns('blind'), [{ id: 'blind', repeat: 0 }])
})

// 重复数从整份 registry 推，不从 --tasks 的子集推：从子集推会把「只跑 2 个 fixture」放大成「每个跑 6 遍」，
// 多花 4 倍的钱。子集只减少运行次数，不改变每个 fixture 跑几遍。
test('a subset selection reduces the run count instead of inflating repeats', () => {
  assert.equal(repeatCount(12, 12), 1)
  assert.equal(repeatCount(3, 1), 3)
  assert.equal(resolveRuns('screening', 'boundary,merge').length, 2)
  assert.deepEqual(resolveRuns('screening', 'boundary,merge').map(run => run.repeat), [0, 0])
  assert.equal(resolveRuns('armA', 'pipeline').length, 3)
})

// 「一共几次」与「跑哪些」对不上时必须直接失败，而不是取整：这正是 NX-08e 少跑 4 次的成因。
test('a run count that does not divide evenly across the registry is rejected', () => {
  assert.throws(() => repeatCount(4, 3), /cannot be split evenly across 3 fixtures/)
  assert.throws(() => repeatCount(0, 1), /cannot be split evenly across 1 fixtures/)
  assert.throws(() => repeatCount(3, 0), /registry cannot be empty/)
})

test('arguments are parsed into one options object with screening as the default phase', () => {
  assert.deepEqual(parseEvalArguments([]), { phase: 'screening', probeOnly: false, planOnly: false })
  assert.deepEqual(parseEvalArguments(['--phase', 'sequence', '--plan-only']), { phase: 'sequence', probeOnly: false, planOnly: true })
  assert.deepEqual(parseEvalArguments(['--phase=sequence', '--tasks=pipeline']), { phase: 'sequence', tasks: 'pipeline', probeOnly: false, planOnly: false })
  // 逐字钉住这份清单：新阶段只加进 phaseNames 却漏了别处时，这条会当场点名，而不是让 `--phase ledgerA1`
  // 在运行期被当成未知阶段拒收。
  assert.throws(() => parseEvalArguments(['--phase', 'bogus']), /unknown phase: bogus; expected one of screening, armA, armB, sequence, smoke, blind, ledgerA1, ledgerA2, ledgerB1, ledgerB2, baseline, context, prompt, full/)
  assert.throws(() => parseEvalArguments(['--phase']), /--phase needs a value/)
  assert.throws(() => parseEvalArguments(['--plan-only=yes']), /--plan-only takes no value/)
  assert.throws(() => parseEvalArguments(['--unknown']), /unknown option: --unknown/)
  assert.throws(() => parseEvalArguments(['sequence']), /unexpected argument: sequence/)
})

// NX-38 的四条臂共用同一 fixture（ledger）与同一份任务集，且各 3 次重复。臂之间的差异只能来自策略：
// 计划一旦不同，「裁掉载体之后还守不守得住」就不再是两臂之间唯一的差别。
test('the four ledger arms plan the same fixture the same number of times', () => {
  for (const phase of ledgerPhases) {
    assert.deepEqual(phaseRegistry(phase), [...ledgerIds], phase)
    assert.deepEqual(resolvePlanned(phase), ['ledger'], phase)
    assert.equal(evidenceScope(phase, resolvePlanned(phase)), 'full', phase)
    assert.deepEqual(resolveRuns(phase), [{ id: 'ledger', repeat: 0 }, { id: 'ledger', repeat: 1 }, { id: 'ledger', repeat: 2 }], phase)
  }
  // 四条臂的计划逐字相同：一次运行是整条四阶段序列，重复 3 次。
  for (const phase of ledgerPhases.slice(1)) assert.deepEqual(resolveRuns(phase), resolveRuns(ledgerPhases[0]), phase)
})

// NX-39 的四格共用同一份任务集（ablationIds = 筛查 12 ＋ 代码理解 4 ＋ 测试编写 4），各 3 次重复。
// 臂之间的差异只能来自两个因子：计划一旦不同，「谁的通过率高」就同时包含了任务难度，四格不再是 2×2。
// 这条同时钉住 `phaseCaps` 的 runs 能被 registry 长度整除——`repeatCount` 的整除约束就在这里生效。
test('the four ablation cells plan the same task set the same number of times', () => {
  assert.deepEqual([...ablationIds], [...screeningIds, 'repro-sessions', 'repro-money', 'repro-tally', 'repro-order', 'mutation-bands', 'mutation-quota', 'mutation-slug', 'mutation-versions'])
  assert.equal(ablationIds.length, 20)
  for (const phase of ablationPhases) {
    assert.deepEqual(phaseRegistry(phase), [...ablationIds], phase)
    assert.deepEqual(resolvePlanned(phase), [...ablationIds], phase)
    assert.equal(evidenceScope(phase, resolvePlanned(phase)), 'full', phase)
    assert.equal(repeatCount(phaseCaps[phase].runs, phaseRegistry(phase).length), 3, phase)
    assert.equal(resolveRuns(phase).length, 20 * 3, phase)
  }
  // 四格的执行清单逐字相同：差异只由策略承担，不来自跑了哪些任务、也不来自跑了几次。这条也是这条注册表
  // 「引用而非修改」的可观察后果——它若改动了 screeningIds，本条的期望值会跟着一起错，而不是当场报错，
  // 因此 screeningIds 自身另有一条按值钉住的断言（见 coding-fixtures.test.ts）。
  for (const phase of ablationPhases.slice(1)) assert.deepEqual(resolveRuns(phase), resolveRuns(ablationPhases[0]), phase)
  assert.deepEqual(resolveRuns('baseline').slice(0, 2), [{ id: 'boundary', repeat: 0 }, { id: 'boundary', repeat: 1 }])
})

// --input-target 是批次 A 第二臂唯一的自变量，且只由 ledgerA2 消费。两条越界各自失败，理由与 --tasks 的
// 越界报错同一类：静默接受等于让一次声称「裁得更狠」的运行其实没改裁剪目标。
test('--input-target is consumed by ledgerA2 only, and never silently', () => {
  assert.deepEqual(parseEvalArguments(['--phase', 'ledgerA2', '--input-target', '6840']), { phase: 'ledgerA2', inputTarget: '6840', probeOnly: false, planOnly: false })
  assert.deepEqual(parseEvalArguments(['--phase=ledgerA2', '--input-target=6840']), { phase: 'ledgerA2', inputTarget: '6840', probeOnly: false, planOnly: false })
  assert.throws(() => parseEvalArguments(['--input-target']), /--input-target needs a value/)
  assert.equal(resolveInputTarget('ledgerA2', '6840'), 6_840)
  assert.equal(resolveInputTarget('ledgerA1'), undefined)
  // 缺目标：A2 没有它就没有自变量，静默退回默认值会让两臂退化成同一臂。
  assert.throws(() => resolveInputTarget('ledgerA2'), /--phase ledgerA2 requires --input-target derived from the ledgerA1 peaks/)
  // 传错阶段：把它塞进一条不改裁剪的臂，账面上看不出来。
  assert.throws(() => resolveInputTarget('ledgerA1', '6840'), /--input-target is only consumed by --phase ledgerA2, not ledgerA1/)
  assert.throws(() => resolveInputTarget('screening', '6840'), /only consumed by --phase ledgerA2/)
  assert.throws(() => resolveInputTarget('ledgerA2', '0'), /positive safe integer/)
  assert.throws(() => resolveInputTarget('ledgerA2', 'abc'), /positive safe integer/)
  assert.throws(() => resolveInputTarget('ledgerA2', '1.5'), /positive safe integer/)
})

// 预注册写死的推导规则：A2 的目标 = floor(0.75 × A1 逐阶段峰值估算输入的最大值)。这条规则之所以要写成
// 函数而不是留给人算，是因为「读到结局再定目标」与「按写死的规则现算」在事后无法区分——只有前者能被排除。
test('the pruning target follows the pre-registered 0.75 x peak rule', () => {
  assert.equal(derivePruningTarget([5260, 6815, 7922, 9121]), 6_840)
  // 取的是最大值而不是第一个：A1 的峰值可能落在任何一次运行上。
  assert.equal(derivePruningTarget([10, 3]), 7)
  assert.equal(derivePruningTarget([3]), 2)
  assert.throws(() => derivePruningTarget([]), /empty peak list/)
})

// 证据行只有 `{phase, fixture, repeat, ...RunOutcome}`：峰值取自该 run 各阶段的 maxEstimatedInputTokens。
// phase 不符即抛错——把 A2 或 B 批的结果误当 A1 的基线，正是「按结果挑仪器」的形状。
test('peaks are recovered from evidence and refuse to be read off another phase', () => {
  const record = (phase: string, peaks: number[]) => ({ phase, tasks: peaks.map(peak => ({ maxEstimatedInputTokens: peak })) })
  assert.deepEqual(ledgerRunPeaks([record('ledgerA1', [5260, 6815]), record('ledgerA1', [9121, 100])]), [6_815, 9_121])
  assert.throws(() => ledgerRunPeaks([record('ledgerA1', [1]), record('ledgerA2', [2])]), /evidence came from ledgerA2, expected ledgerA1/)
  assert.throws(() => ledgerRunPeaks([{ phase: 'ledgerA1', tasks: [] }]), /recorded no stage projections/)
})

// 不可行是人的判断且影响成功率分母：不给理由就不允许使用这个口径，理由也不能是空白。
test('declaring a task infeasible requires a stated reason', () => {
  assert.deepEqual(resolveInfeasible('screening', undefined, undefined), { ids: new Set(), reason: undefined })
  assert.throws(() => resolveInfeasible('screening', undefined, 'no spec'), /--infeasible-reason without --infeasible/)
  assert.throws(() => resolveInfeasible('screening', 'merge', undefined), /--infeasible requires --infeasible-reason/)
  assert.throws(() => resolveInfeasible('screening', 'merge', '   '), /--infeasible requires --infeasible-reason/)
  const declared = resolveInfeasible('screening', 'merge', ' spec is contradictory ')
  assert.deepEqual([...declared.ids], ['merge'])
  assert.equal(declared.reason, 'spec is contradictory')
})

// 窗口必须显式：自定义端点不允许靠模型名猜容量，否则投影会静默退化成无上限。
test('the evaluation model and context window come from explicit configuration', () => {
  assert.equal(resolveModel({ MINI_DSH_MODEL: 'deepseek/deepseek-v4-flash' }), 'deepseek/deepseek-v4-flash')
  assert.equal(resolveModel({ MINI_DSH_MODEL: 'a', MINI_DSH_EVAL_MODEL: 'b' }), 'b')
  assert.throws(() => resolveModel({}), /MINI_DSH_MODEL is required/)
  assert.throws(() => resolveModel({ MINI_DSH_MODEL: '  ' }), /MINI_DSH_MODEL is required/)

  assert.equal(resolveContextWindow({}, 'https://api.deepseek.com'), 1_000_000)
  assert.equal(resolveContextWindow({ MINI_DSH_EVAL_CONTEXT_WINDOW: '200000' }, 'https://api.deepseek.com'), 200_000)
  assert.throws(() => resolveContextWindow({}, 'https://example.com'), /required for a non-official endpoint/)
  assert.throws(() => resolveContextWindow({ MINI_DSH_EVAL_CONTEXT_WINDOW: '0' }, 'https://api.deepseek.com'), /positive safe integer/)
  assert.throws(() => resolveContextWindow({ MINI_DSH_EVAL_CONTEXT_WINDOW: 'many' }, 'https://api.deepseek.com'), /positive safe integer/)
})
