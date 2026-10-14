import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { classifyAblation, percentile, readHistoricalPrediction, reportExitCode, summarizeCell } from '../scripts/eval-aggregate.js'
import type { CellRun, CellSummary } from '../scripts/eval-aggregate.js'
import { ablationPhases, phaseCaps } from '../scripts/eval-runner.js'
import type { AblationPhase } from '../scripts/eval-runner.js'

// NX-39-5 的聚合器。它必须在**付费之前**建好并被用例喂合成记录跑过一遍：口径一旦只在跑完之后才成形，
// 「报哪些量、按什么分母」就变成了事后挑指标——那正是预注册要防的事。
//
// 这里的每条用例针对的都是一个具体的失效方式，不是「跑通了」：
//   · 分母：不可行与基础设施失败不进成功率分母，触顶率的分母是**计划**数（含未执行的）。
//   · 因子触发率：0/0 记 null 而不是 0——「没跑」与「跑了但没触发」压成同一个数，仪器就没法证伪。
//   · 层 A 先于层 B：仪器没立起来时谈结局就是谈噪音。顺序写死在 classifyAblation 里。

const run = (overrides: Partial<CellRun> & { fixture: string }): CellRun => ({ phase: 'baseline', repeat: 0, status: 'completed', accepted: true, counters: {}, ...overrides })

// 一格 36 次运行（前三类 12 项 × 3 遍）的合成证据，用来把预注册下界那条判据钉住。
const historicalRuns = (accepted: number, phase: AblationPhase = 'baseline'): CellRun[] => {
  const ids = ['boundary', 'pagination', 'interface', 'inventory', 'options', 'normalize', 'dedupe', 'query', 'retry', 'merge', 'csv', 'summary']
  return ids.flatMap((fixture, index) => [0, 1, 2].map(repeat => run({ fixture, repeat, phase, accepted: index * 3 + repeat < accepted })))
}

test('percentiles pick a value that actually exists in the sample', () => {
  assert.equal(percentile([], 0.5), null)
  assert.equal(percentile([5], 0.95), 5)
  // 最近秩：10 个样本的 p95 取第 10 个，不是插值出来的第 9.55 个。
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95), 10)
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5), 5)
  // 顺序不影响结果，且不改动传入的数组。
  const values = [30, 10, 20]
  assert.equal(percentile(values, 0.5), 20)
  assert.deepEqual(values, [30, 10, 20])
})

test('a cell splits success by category and keeps the unratable runs out of the denominator', () => {
  const cell = summarizeCell('baseline', 6, [
    run({ fixture: 'boundary', accepted: true }),
    run({ fixture: 'pagination', accepted: false }),
    // 不可行与基础设施失败都单列，不进分母——否则「少跑了几个」会被读成「模型失败率下降了」。
    run({ fixture: 'interface', accepted: false, infeasible: true }),
    run({ fixture: 'options', accepted: false, error: 'boom' }),
    run({ fixture: 'normalize', accepted: true }),
    run({ fixture: 'dedupe', accepted: true }),
  ])
  const rate = (category: string) => cell.rates.find(item => item.category === category)!
  assert.deepEqual({ accepted: rate('bugfix').accepted, denominator: rate('bugfix').denominator }, { accepted: 1, denominator: 2 })
  assert.deepEqual({ accepted: rate('refactor').accepted, denominator: rate('refactor').denominator }, { accepted: 0, denominator: 0 })
  assert.deepEqual({ accepted: rate('feature').accepted, denominator: rate('feature').denominator }, { accepted: 2, denominator: 2 })
  // 后两类在这条合成证据里一次都没跑：分母 0、跑数 0，不能被读成「通过率 0」。
  assert.deepEqual({ accepted: rate('comprehension').accepted, denominator: rate('comprehension').denominator, runs: rate('comprehension').runs }, { accepted: 0, denominator: 0, runs: 0 })
  assert.equal(cell.infeasible, 1)
  assert.equal(cell.errored, 1)
  assert.equal(cell.rateable, 4)
})

test('the ceiling rate counts the unexecuted planned runs, not only the token_budget stops', () => {
  const cell = summarizeCell('baseline', 4, [
    run({ fixture: 'boundary', status: 'token_budget' }),
    run({ fixture: 'pagination', status: 'completed' }),
  ])
  // 计划 4 次、执行 2 次：分子 = 1 次 token_budget ＋ 2 次未执行 = 3，分母是**计划**数 4。
  // 只数 token_budget 会把「整批上限把剩下的掐掉了」读成一个更小的数——而因子 1 的开档正是靠
  // 压低每轮输入在同一个 maxTotalTokens 下占到便宜的，不报这一项就没法排除「谁先撞墙」。
  assert.deepEqual(cell.ceiling, { tokenBudget: 1, notExecuted: 2, numerator: 3, denominator: 4, rate: 0.75 })
  assert.equal(cell.executed, 2)
  assert.equal(cell.notExecuted, 2)
})

test('a trigger with no runs reads as null rather than zero', () => {
  const empty = summarizeCell('context', 3, [])
  assert.deepEqual(empty.triggers.pressure, { triggered: 0, runs: 0, rate: null })
  assert.deepEqual(empty.triggers.truncation, { triggered: 0, runs: 0, rate: null })
  // 多轮占比的分母是**多轮** run：单轮 run 谈不上「与前一轮相同」，把它算进分母只会稀释读数。
  assert.deepEqual(empty.triggers.stablePrompt, { triggered: 0, multiRound: 0, runs: 0, rate: null })
  const single = summarizeCell('context', 1, [run({ fixture: 'boundary', tasks: [{ promptRounds: { rounds: 1, stable: 0 } }] as never })])
  assert.deepEqual(single.triggers.stablePrompt, { triggered: 0, multiRound: 0, runs: 1, rate: null })
})

test('the three trigger rates come from three different stage fields', () => {
  const cell = summarizeCell('full', 4, [
    // 主动压缩出手：pressure > 0（不是 applied > 0——兜底压缩不看阈值，出手并不说明主动那一半触发了）。
    run({ fixture: 'boundary', tasks: [{ compactions: { applied: 2, pressure: 1, declined: 0 }, promptRounds: { rounds: 3, stable: 2 } }] as never }),
    // 只有兜底压缩：applied > 0 但 pressure = 0，不算主动那一半触发。
    run({ fixture: 'pagination', tasks: [{ compactions: { applied: 1, pressure: 0, declined: 0 } }] as never }),
    // 预览截断看 counters，不看 compactions。
    run({ fixture: 'options', counters: { previewTruncations: 3 }, tasks: [] }),
    // context_overflow 单列，且它既不算「被拒」也不算「没触发」。
    run({ fixture: 'normalize', accepted: false, status: 'context_overflow', tasks: [{ status: 'context_overflow' }] as never }),
  ])
  assert.deepEqual(cell.triggers.pressure, { triggered: 1, runs: 4, rate: 0.25 })
  assert.deepEqual(cell.triggers.truncation, { triggered: 1, runs: 4, rate: 0.25 })
  assert.deepEqual(cell.triggers.stablePrompt, { triggered: 1, multiRound: 1, runs: 4, rate: 1 })
  assert.equal(cell.triggers.contextOverflowStages, 1)
})

test('the six metric families add up, and latency is reported per request', () => {
  const cell = summarizeCell('baseline', 2, [
    run({ fixture: 'boundary', counters: { modelRequests: 5, toolCalls: 4, toolErrors: 1, previewTruncations: 0, inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadTokens: 30 }, tasks: [{ requestDurationsMs: [10, 20, 30] }] as never }),
    run({ fixture: 'pagination', counters: { modelRequests: 3, toolCalls: 2, toolErrors: 0, previewTruncations: 2, inputTokens: 50, outputTokens: 10, totalTokens: 60, cacheReadTokens: 0 }, tasks: [{ requestDurationsMs: [40] }] as never }),
  ])
  assert.equal(cell.metrics.modelRounds, 8)
  assert.equal(cell.metrics.toolCalls, 6)
  assert.equal(cell.metrics.toolErrors, 1)
  assert.equal(cell.metrics.previewTruncations, 2)
  assert.deepEqual(cell.metrics.tokens, { input: 150, output: 30, total: 180, cache: 30 })
  assert.deepEqual(cell.metrics.latency, { requests: 4, p50: 20, p95: 40, max: 40 })
})

test('the historical floor is read against the three categories that have a history, and only when complete', () => {
  const full = (accepted: number, phase: AblationPhase) => summarizeCell(phase, 36, historicalRuns(accepted, phase))
  const met = readHistoricalPrediction([full(36, 'baseline'), full(35, 'context'), full(36, 'prompt'), full(35, 'full')])
  assert.equal(met.verdict, 'met')
  assert.equal(met.spread, 1)
  // 差 2 次就跌破下界（33/36）——这条是可证伪的，不是「差不多就行」。
  const below = readHistoricalPrediction([full(36, 'baseline'), full(33, 'context'), full(36, 'prompt'), full(35, 'full')])
  assert.equal(below.verdict, 'below-floor')
  assert.equal(below.spread, 3)
  // 有一格没跑满就读不出来：分母不是 36 时「通过率」与预注册的下界不同口径。
  const short = summarizeCell('full', 36, historicalRuns(12, 'full').slice(0, 12))
  assert.equal(readHistoricalPrediction([full(36, 'baseline'), full(35, 'context'), full(36, 'prompt'), short]).verdict, 'incomplete')
})

// 层 A 先于层 B，且「裁剪」不参与这条判定：它在 20 项单任务上是结构性零，那是开跑前就声明过的范围，
// 把「结构性零」与「触发率零」混成一句话，就会在报告里把一件已知的事读成一次新发现。
test('the instrument verdict comes first, and only about the two halves the batch can measure', () => {
  const cell = (phase: AblationPhase, pressure: number, truncation: number): CellSummary => summarizeCell(phase, 2, [
    run({ fixture: 'boundary', phase, counters: { previewTruncations: truncation }, tasks: [{ compactions: { applied: pressure, pressure, declined: 0 } }] as never }),
    run({ fixture: 'pagination', phase, counters: { previewTruncations: truncation }, tasks: [{ compactions: { applied: pressure, pressure, declined: 0 } }] as never }),
  ])
  const cells = [cell('baseline', 0, 0), cell('context', 2, 2), cell('prompt', 0, 0), cell('full', 1, 1)]
  const established = classifyAblation(cells)
  // 四格全是 2 次运行、计划也是 2 次 ⇒ 跑满 ⇒ 走层 B。结局相同 ⇒ 天花板未破。
  assert.equal(established.verdict, 'ceiling-intact')
  // 开着的两格都是 0 ⇒ 仪器未成立，且理由点出是哪一半。
  const dead = classifyAblation([cell('baseline', 0, 0), cell('context', 0, 0), cell('prompt', 0, 0), cell('full', 0, 0)])
  assert.equal(dead.verdict, 'instrument-not-established')
  assert.ok(dead.reasons.some(reason => reason.includes('主动压缩')), dead.reasons.join('；'))
  assert.ok(dead.reasons.some(reason => reason.includes('工具输出有界')), dead.reasons.join('；'))
  // 只有一半死掉也是未成立：任一半触发率为 0 就不进层 B。
  const halfDead = classifyAblation([cell('baseline', 0, 0), cell('context', 2, 0), cell('prompt', 0, 0), cell('full', 2, 0)])
  assert.equal(halfDead.verdict, 'instrument-not-established')
  assert.ok(!halfDead.reasons.some(reason => reason.includes('主动压缩')), '主动压缩出手过一次，不该被报成未成立')
})

test('the instrument is judged on the cells that turn the factor on', () => {
  // baseline / prompt 关着因子 1，它们为 0 是**设计**，不能拿来判「仪器未成立」。两半必须都只在开着的
  // 两格上量：任何一半在 context／full 上出手过，这一半就不算死。
  const cell = (phase: AblationPhase, on: boolean): CellSummary => summarizeCell(phase, 1, [
    run({ fixture: 'boundary', phase, counters: { previewTruncations: on ? 1 : 0 }, tasks: [{ compactions: { applied: on ? 1 : 0, pressure: on ? 1 : 0, declined: 0 } }] as never }),
  ])
  const reading = classifyAblation([cell('baseline', false), cell('context', true), cell('prompt', false), cell('full', true)])
  assert.equal(reading.verdict, 'ceiling-intact')
  // 反过来：关着因子 1 的两格上出现非零触发率，说明接线坏了（它们本该一次都不出手）。此时判据仍必须只看
  // 开着的两格——那两格都是 0 就是「仪器未成立」，不能被坏掉的那格「看起来有触发」盖过去。
  const miswired = classifyAblation([cell('baseline', true), cell('context', false), cell('prompt', false), cell('full', false)])
  assert.equal(miswired.verdict, 'instrument-not-established')
  assert.ok(miswired.reasons.some(reason => reason.includes('主动压缩')))
  // 判据是「开着的两格上**都**为零」，不是「都非零」：某一格没触发而另一格触发过，说明这一半的装置
  // 是成立的，该格没触发这件事由它自己那行的触发率如实报出，不升级成整批「仪器未成立」。
  const lopsided = classifyAblation([
    cell('baseline', false), cell('context', true), cell('prompt', false),
    summarizeCell('full', 1, [run({ fixture: 'boundary', phase: 'full', counters: { previewTruncations: 0 }, tasks: [{ compactions: { applied: 1, pressure: 1, declined: 0 } }] as never })]),
  ])
  assert.equal(lopsided.verdict, 'ceiling-intact')
  assert.equal(lopsided.cells.find(item => item.phase === 'full')?.triggers.truncation.rate, 0, '该格没触发必须如实报 0，而不是被整批判定吞掉')
})

test('a batch where nothing ran is rejected rather than read as an intact ceiling', () => {
  const empty = (phase: AblationPhase) => summarizeCell(phase, 60, [])
  const reading = classifyAblation(ablationPhases.map(empty))
  assert.equal(reading.verdict, 'rejected')
  assert.ok(reading.reasons.some(reason => reason.includes('0 次运行')))
  // 同一件事在退出码上：报告命令不能靠「跑得少」成功，也不能把没跑满的一格当成跑完了。
  assert.equal(reportExitCode(ablationPhases.map(empty)), 1)
  const partial = ablationPhases.map((phase, index) => summarizeCell(phase, 60, index === 0 ? [run({ fixture: 'boundary' })] : []))
  assert.equal(reportExitCode(partial), 1)
  const complete = ablationPhases.map(phase => summarizeCell(phase, 1, [run({ fixture: 'boundary', phase })]))
  assert.equal(reportExitCode(complete), 0)
})

test('the report command refuses to run without evidence instead of printing an empty table', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nx39-aggregate-'))
  const script = fileURLToPath(new URL('../scripts/eval-ablation-report.js', import.meta.url))
  try {
    const result = spawnSync(process.execPath, [script, root], { encoding: 'utf8' })
    assert.equal(result.status, 1)
    // 它必须点名缺的是哪一格的哪份文件，而不是只说「没有证据」——缺证据时的下一步是去跑那一格。
    for (const phase of ablationPhases) assert.ok(result.stderr.includes(`${phase}-full`), result.stderr)
    assert.match(result.stderr, /pnpm eval:screening --phase baseline/)

    // 四格都在、但每份都是空的：仍然退 1（「什么都没跑成」不算成功）。
    for (const phase of ablationPhases) {
      const directory = path.join(root, `${phase}-full`)
      await fs.mkdir(directory, { recursive: true })
      await fs.writeFile(path.join(directory, 'runs.jsonl'), '')
    }
    const emptyRun = spawnSync(process.execPath, [script, root], { encoding: 'utf8' })
    assert.equal(emptyRun.status, 1)
    assert.match(emptyRun.stdout, /判定：rejected/)

    // 有证据时给出判定并退 0；这里用一格「跑满且全通过」的最小证据，只为把退出码那半边钉住。
    await fs.writeFile(path.join(root, 'baseline-full', 'runs.jsonl'), `${JSON.stringify(run({ fixture: 'boundary' }))}\n`)
    const report = spawnSync(process.execPath, [script, root], { encoding: 'utf8' })
    assert.match(report.stdout, /前三类小计/)
    assert.match(report.stdout, /后两类小计/)
    assert.equal(report.status, 1, '只有一格有证据、且没跑满（1/60），仍须退 1')
  } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()))
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('the four cells are read with the pre-registered planned counts, not with what happened to show up', () => {
  // 计划数只能来自 phaseCaps：从证据行数反推计划数，会把「整批上限掐掉了一半」读成「计划就是那样」。
  for (const phase of ablationPhases) assert.equal(summarizeCell(phase, phaseCaps[phase].runs, []).planned, 60)
})
