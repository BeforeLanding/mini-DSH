import { fixtureIds } from './coding-fixtures.js'
import { runPhase, phaseCaps, summarize } from './eval-runner.js'
import { runFixtureTask, scriptedAdapter } from './eval-fixture.js'

// 离线验证：用模拟模型把筛查阶段的 12 个任务全部跑完，证明运行器接线与整批上限核算成立。
// 通过率不作为模型能力证据，真实对照自 NX-08d 起换用真实适配器。
const report = await runPhase('screening', fixtureIds.map(id => ({ id })), phaseCaps.screening, task => runFixtureTask(task.id, scriptedAdapter))
console.log(JSON.stringify({
  note: '模拟模型驱动，用于验证运行器与整批上限；通过率不作为模型能力证据',
  ...summarize(report),
  runs: report.executed.map(run => ({
    fixture: run.task.id, status: run.status, accepted: run.accepted,
    requests: run.counters.modelRequests, toolCalls: run.counters.toolCalls, tokens: run.counters.totalTokens,
    ...(run.error === undefined ? {} : { error: run.error }),
  })),
}, null, 2))
if (report.aborted || report.executed.length !== report.planned || report.executed.some(run => run.accepted !== true)) process.exitCode = 1
