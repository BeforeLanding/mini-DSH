import path from 'node:path'
import { createFixture, readFixtureFile } from './coding-fixtures.js'
import { assembleDemoHarness, heading } from './demo-context.js'
import { CLI_BUDGET, BudgetStop } from '../src/core/budget.js'
import { assertToolProtocol } from '../src/core/context-runtime.js'
import type { ChatRequest, ChatResponse, Message, ToolCall } from '../src/core/contracts.js'

// NX-10 第二幕：预算停止 → 同任务恢复。
// 要看的是三件事：停止发生在派发之前（那条编辑被执行了吗）、续跑是**同一 task 的另一段 run**、
// 以及已经完成的工具不会被重放。这三件都由断言判定，不由旁白担保。
heading('NX-10 第二幕：预算停止 → 同 task 恢复（不重放已完成的工具）')

const fixture = await createFixture('repair')
const initial = fixture.edits[0].oldText
const full = fixture.edits[0].newText
const partial = await readFixtureFile('repair', 'partial/src/cart.mjs')

const steps: { label: string; call: ToolCall }[] = [
  { label: '读取现行实现', call: { id: 'read-source', name: 'read_file', arguments: { path: 'src/cart.mjs' } } },
  { label: '先跑一次公开检查，确认此刻是失败的', call: { id: 'failed-check', name: 'bash', arguments: { command: 'node check.mjs' } } },
  { label: '第一步修复（只修第一条规则）', call: { id: 'partial-fix', name: 'edit_file', arguments: { path: 'src/cart.mjs', oldText: initial, newText: partial } } },
  { label: '第二步修复——它会被跳过（请求预算在第 3 次请求之后耗尽）', call: { id: 'deferred-fix', name: 'edit_file', arguments: { path: 'src/cart.mjs', oldText: partial, newText: full } } },
  { label: '恢复后补做的验证检查', call: { id: 'final-check', name: 'bash', arguments: { command: 'node check.mjs', verification: { files: ['src/cart.mjs', 'check.mjs'] } } } },
  { label: '恢复后的交付报告', call: { id: 'report', name: 'task_report', arguments: {} } },
]

// 与 demo-context 的 scriptedSteps 的区别：按「哪几步真的被回答了」推进，而不是按请求次数推进。
// 预算停止时那条编辑从未派发，真实模型续跑时会把它重新发一次；若按请求计数推进，这一步会凭空
// 消失，工作区就永远停在中间态——这正是按结果推进与按次数推进可观察到的差别。
function resumeSteps(steps: readonly { call: ToolCall }[]) {
  const answered = (messages: Message[], id: string) => {
    if (!messages.some(message => message.tool_calls?.some(call => call.id === id))) return false
    // 取**最后一条**同名结果：同一个 id 在停止那一段留下的是 skipped，恢复后才是真正的那次。
    // 取第一条会把已经补做的步骤判成仍未回答，于是无休止地重发同一条命令。
    const result = [...messages].reverse().find(message => message.role === 'tool' && message.tool_call_id === id)
    return result !== undefined && !/skipped after max_steps/.test(result.content ?? '')
  }
  return () => ({
    provider: 'scripted', model: 'demo', capabilities: { demo: { contextWindowTokens: 1_000_000 } },
    chat: async ({ messages = [] }: ChatRequest): Promise<ChatResponse> => {
      assertToolProtocol(messages)
      const next = steps.find(step => !answered(messages, step.call.id))
      return next ? { toolCalls: [next.call] } : { content: '脚本化模型：预设序列执行完毕' }
    },
  })
}

// 第一段只给 4 次请求。第 4 次请求本身发得出去，但它带回的那条编辑在**派发之前**被拦下，
// 所以前 3 条命令真的执行了、第 4 条一次都没有跑。拦它的不是 maxSteps 这类固定轮数上限，而是
// 可配置的请求预算（AGENTS.md 禁止悄悄加入固定轮数限制）。
const harness = await assembleDemoHarness(fixture, resumeSteps(steps), {
  budget: { ...CLI_BUDGET, maxModelRequests: 4 },
  sessionDirectory: path.join('.demo-runs', 'demo-resume'),
})
// 逐段打印：两段的工具结果混在一起读不出「哪些是这次恢复补做的」。
const results = (root: typeof harness.root, sessionId: string, runId?: string) =>
  root.sessions.visibleEvents(sessionId).flatMap(event => event.type === 'tool/result' && (runId === undefined || event.runId === runId)
    ? [{ id: event.data.toolCallId, name: event.data.name ?? '?', status: event.data.status ?? 'completed', content: event.data.content }] : [])
const started = (root: typeof harness.root, sessionId: string, runId?: string) =>
  root.sessions.visibleEvents(sessionId).flatMap(event => event.type === 'tool/start' && (runId === undefined || event.runId === runId) ? [event.data.toolCallId] : [])
let failed = false

try {
  const task = fixture.tasks[0]
  let reason: string | undefined
  try {
    await harness.agent.send(task)
  } catch (error) {
    if (!(error instanceof BudgetStop)) throw error
    reason = error.reason
  }
  const first = harness.root.sessions.latestRun(harness.sessionId)
  heading('[1] 第一段：预算 maxModelRequests=4')
  console.log(`  停止原因 stopReason=${reason}，run 状态=${first?.status}，请求 ${first?.counters.modelRequests} 次、工具 ${first?.counters.toolCalls} 次`)
  for (const result of results(harness.root, harness.sessionId, first?.runId)) console.log(`  [${result.status}] ${result.id} ${result.name}`)
  const skipped = results(harness.root, harness.sessionId, first?.runId).find(result => result.status === 'skipped')
  console.log(`  被跳过的调用原文：${JSON.stringify(skipped?.content ?? null)}`)
  console.log('  它没有对应的 tool/start，说明停止发生在派发之前——工作区仍是中间态，公开检查仍然失败。')

  heading('[2] 恢复：同一 task 的另一段 run')
  await harness.agent.continue({ budget: { ...CLI_BUDGET, maxModelRequests: 8 } })
  const second = harness.root.sessions.latestRun(harness.sessionId)
  const state = (taskId: string) => harness.root.sessions.taskState(harness.sessionId, taskId)
  const all = results(harness.root, harness.sessionId)
  for (const result of results(harness.root, harness.sessionId, second?.runId)) console.log(`  [${result.status}] ${result.id} ${result.name}`)
  console.log(`  第二段 run=${second?.runId} 同任务上一段=${second?.previousRunId}，状态=${second?.status}`)
  const report = all.find(result => result.name === 'task_report')
  if (report) for (const line of (JSON.parse(report.content) as { runs?: { runId?: string; previousRunId?: string; status?: string }[] }).runs ?? []) console.log(`  [run] ${line.runId} 同任务上一段=${line.previousRunId ?? '—'} status=${line.status}`)
  console.log('  （报告是在第二段 run 内查询的，所以它自己那一行还是 running；上面那行状态才是这一段结束后的终值。）')

  const acceptance = await fixture.evaluate()
  const taskId = second?.taskId ?? ''
  const ids = started(harness.root, harness.sessionId)
  const replayed = ids.filter((id, index) => ids.indexOf(id) !== index)
  heading('[3] 判定')
  const checks: [string, boolean][] = [
    ['第一段确实因 max_steps 停止', reason === 'max_steps'],
    // 「没有执行」只对**停止那一段**成立：恢复之后同一个 id 当然会真的跑一次（见下面那条「不重放」）。
    ['被跳过的编辑在第一段没有派发（无 tool/start）', skipped !== undefined && !started(harness.root, harness.sessionId, first?.runId).includes(skipped.id)],
    ['它在恢复后真的执行了一次', skipped !== undefined && started(harness.root, harness.sessionId, second?.runId).includes(skipped.id)],
    ['续跑是同一 task，continuations=1', state(taskId).continuations === 1],
    ['没有任何工具被执行两次', replayed.length === 0],
    ['两段 run 的前后关系被记录', second?.previousRunId === first?.runId],
    ['最终 run completed 且独立验收通过', second?.status === 'completed' && acceptance.passed && acceptance.exitCode === 0],
  ]
  for (const [label, ok] of checks) console.log(`  ${ok ? '✓' : '✗'} ${label}`)
  console.log(`  恢复后工作区独立验收 ${JSON.stringify(acceptance.output.trim())}，退出码 ${acceptance.exitCode}`)
  console.log(`  事件日志：${path.join('.demo-runs', 'demo-resume', harness.sessionId, 'events.jsonl')}`)
  failed = checks.some(([, ok]) => !ok)
} catch (error) {
  failed = true
  const broken = harness.root.sessions.latestRun(harness.sessionId)
  console.error(`第二幕失败：${error instanceof Error ? error.message : String(error)}`)
  console.error(`  run=${broken?.runId} previous=${broken?.previousRunId ?? '—'} status=${broken?.status} requests=${broken?.counters.modelRequests} maxModelRequests=${broken?.policy.maxModelRequests}`)
} finally {
  await harness.dispose()
}
if (failed) process.exitCode = 1
