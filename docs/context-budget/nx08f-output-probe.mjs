import { runFixtureTask } from '../../dist/scripts/eval-fixture.js'
import { evalPolicy } from '../../dist/scripts/eval-runner.js'
import { assertToolProtocol } from '../../dist/src/core/context-runtime.js'

// NX-08f-3 诊断探针，与 nx08e-prune-probe.mjs / nx17-gate-probes.mjs 同类：不是回归断言，不参与
// pnpm check / pnpm test / CI 门禁。pnpm build 之后 node 直接跑。
//
// 要回答的问题：同一台 `audit` 仪器、同一预算下，只切「工具输出是否有界」，两臂的结局是否真的分叉？
// 适配器是脚本化的固定序列（跑公开检查 → 跑报告 → 读两个源文件 → 改两个源文件 → 复跑检查），所以这里
// 测到的是 **Harness 的机制**：同一份报告进入历史后，无界臂在下一个投影就越过输入目标、有界臂走完并
// 通过验收。**真实模型是否会真的产生那份报告，这个探针答不了**——那是 NX-08f-4b 的付费烟测要回答的，
// 本探针的结论不得写成「真实模型下也一样」。
//
// 与 test/eval-runner.test.ts 里那条用例是同一个装置：用例钉行为（断言两个结局），探针把同一装置的数
// 值打出来供人核对与回填文档。改一处时要同时改另一处。

const budget = { ...evalPolicy, maxModelRequests: 16 }
const inputTarget = evalPolicy.inputTargetTokens ?? 0

// 固定工具序列。edit 的 oldText/newText 直接取 fixture 的参考解，因此这条路径能真正走到「通过验收」，
// 而不是停在「跑到一半」——有界臂必须能完成，否则无界臂的溢出就不是差异而是唯一的结局。
const scriptedAudit = fixture => {
  const commands = [
    { id: 'check-before', name: 'bash', arguments: { command: 'node check.mjs' } },
    { id: 'report', name: 'bash', arguments: { command: 'node report.mjs' } },
    ...fixture.edits.map((edit, index) => ({ id: `read-${index}`, name: 'read_file', arguments: { path: edit.path } })),
    ...fixture.edits.map((edit, index) => ({ id: `edit-${index}`, name: 'edit_file', arguments: edit })),
    { id: 'check-after', name: 'bash', arguments: { command: 'node check.mjs' } },
  ]
  let step = 0
  return {
    provider: 'scripted', model: 'fixture', capabilities: { fixture: { contextWindowTokens: 1_000_000 } },
    chat: async ({ messages = [] }) => {
      assertToolProtocol(messages)
      return step < commands.length ? { toolCalls: [commands[step++]] } : { content: 'audit finished' }
    },
  }
}

console.log(`输入目标 ${inputTarget} token；单次 run 预算 ${budget.maxModelRequests} 请求 / ${budget.maxTotalTokens} token`)
console.log('臂      状态                验收    请求  工具  token     峰值估算输入   投影次数  未发出投影')
for (const bounded of [true, false]) {
  const outcome = await runFixtureTask('audit', scriptedAudit, budget, undefined, { bounded })
  const stage = outcome.tasks?.[0] ?? {}
  console.log([
    bounded ? '有界  ' : '无界  ',
    String(outcome.status).padEnd(18),
    String(outcome.accepted).padEnd(6),
    String(outcome.counters.modelRequests).padEnd(5),
    String(outcome.counters.toolCalls).padEnd(4),
    String(outcome.counters.totalTokens).padEnd(9),
    String(stage.maxEstimatedInputTokens ?? '-').padEnd(14),
    String(stage.projections ?? '-').padEnd(9),
    stage.unsentProjections ?? '-',
  ].join(' '))
}
// 单任务会话里 removedTaskIds 恒为空（当前 task 恒 protected）：这一列在这里没有信息量，因此不打。
// 有界臂与无界臂的差别只应体现在「峰值估算输入」与「结局」两列上。
