import path from 'node:path'
import { createFixture, readFixtureFile } from './coding-fixtures.js'
import { assembleDemoHarness, scriptedSteps, heading, excerpt } from './demo-context.js'
import type { ToolCall } from '../src/core/contracts.js'

// NX-10 第一幕：项目规则 → 定位 → 修改 → 失败测试 → 再修复 → diff 与证据。
// 模型是预设的脚本化序列，因此逐字可复现：不读 .env、不出网、不调用付费 API。
// 每一步的结果都按原文打印（见 demo-context.ts 的 excerpt），不做改写——演示要让人核对的是
// Harness 真的产出了什么，而不是我们转述了什么。
heading('NX-10 第一幕：项目规则 → 定位 → 修改 → 失败测试 → 再修复 → diff 与证据')

const fixture = await createFixture('repair')
const initial = fixture.edits[0].oldText
const full = fixture.edits[0].newText
// 中间态：只修好第一条规则。它真的过不了公开检查，由 test/coding-fixtures.test.ts 钉住。
const partial = await readFixtureFile('repair', 'partial/src/cart.mjs')

// 交付报告的原始 JSON 里绝大部分是逐次 usage 明细，读起来盖过了要看的行。这一步按报告自己的字段重排，
// 只投影 run 关系、文件覆盖与检查记录——不改任何数值，也不替它下结论。
function deliverySummary(value: unknown) {
  const report = value as {
    runStatus?: string; stopReason?: string | null; acceptance?: string
    runs?: { runId?: string; previousRunId?: string; status?: string; stopReason?: string | null }[]
    files?: { path?: string; status?: string; verification?: string; coveredBy?: string[] }[]
    unverifiedFiles?: string[]
    checks?: { status?: string; freshness?: string; commandResult?: { command?: string; exitCode?: number | null } }[]
    verificationTotal?: number
  }
  const lines = [`runStatus=${report.runStatus} stopReason=${report.stopReason ?? '—'} acceptance=${report.acceptance}`]
  for (const run of report.runs ?? []) lines.push(`[run]   ${run.runId} 同任务上一段=${run.previousRunId ?? '—'} status=${run.status} stop=${run.stopReason ?? '—'}`)
  for (const file of report.files ?? []) lines.push(`[file]  ${file.path} status=${file.status} verification=${file.verification} coveredBy=${JSON.stringify(file.coveredBy ?? [])}`)
  lines.push(`[未覆盖] ${JSON.stringify(report.unverifiedFiles ?? [])}`)
  lines.push(`[检查记录] 共 ${report.verificationTotal ?? 0} 条；第 5 步那次失败的 bash 没有声明 verification.files，因此不在这里——普通命令不构成检查。`)
  for (const check of report.checks ?? []) lines.push(`[check] status=${check.status} freshness=${check.freshness} command=${JSON.stringify(check.commandResult?.command ?? null)} exit=${check.commandResult?.exitCode ?? null}`)
  lines.push(`（报告是在 run 内查询的，所以 runStatus 还是 running；完整 JSON 见事件日志）`)
  return lines.join('\n')
}

const steps: { label: string; call: ToolCall; render?(value: unknown): string }[] = [
  { label: '项目规则：查询 src 作用域（根规则已由 project:context 注入系统提示）', call: { id: 'rules-src', name: 'project_context', arguments: { directory: 'src' } } },
  { label: '定位：在工作区里搜索折扣相关实现', call: { id: 'locate-grep', name: 'grep', arguments: { path: 'src', query: 'discount' } } },
  { label: '定位：读取现行实现（read_file 同时给出 expectedHash 用的整文件哈希）', call: { id: 'locate-read', name: 'read_file', arguments: { path: 'src/cart.mjs' } } },
  { label: '修改：只修第一条规则（单项折扣）', call: { id: 'edit-partial', name: 'edit_file', arguments: { path: 'src/cart.mjs', oldText: initial, newText: partial } } },
  { label: '失败测试：公开检查仍未通过', call: { id: 'check-fail', name: 'bash', arguments: { command: 'node check.mjs' } } },
  { label: '再修复：第二条规则（整单百分数与取整）', call: { id: 'edit-full', name: 'edit_file', arguments: { path: 'src/cart.mjs', oldText: partial, newText: full } } },
  { label: '验证检查：显式声明这次命令覆盖了哪些文件', call: { id: 'check-pass', name: 'bash', arguments: { command: 'node check.mjs', verification: { files: ['src/cart.mjs', 'check.mjs'] } } } },
  { label: 'diff：任务变更清单（相对首次观察的基线）', call: { id: 'changes', name: 'task_changes', arguments: { includeDiff: true } } },
  { label: '证据：交付报告（覆盖 / 未覆盖 / 检查记录）', call: { id: 'report', name: 'task_report', arguments: {} }, render: deliverySummary },
]

const sessionDirectory = path.join('.demo-runs', 'demo-fix')
const harness = await assembleDemoHarness(fixture, scriptedSteps(steps), { sessionDirectory })
const observations: { name: string; value: unknown; rendered: string }[] = []
let failed = false

try {
  const inspect = harness.root.systemPrompt.inspect()
  const entries = [
    ...inspect.sections.map(entry => ({ kind: 'section', ...entry })),
    ...inspect.contexts.map(entry => ({ kind: 'context', ...entry })),
  ].sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
  heading('[1] 项目规则：系统提示里装配了什么')
  for (const entry of entries) console.log(`  ${entry.kind.padEnd(8)} ${entry.name.padEnd(22)} order ${entry.order}`)
  console.log('  agent:identity 是 coding 身份；project:context 把 workspace 的 AGENTS.md 规则随每个请求注入。')
  console.log('  同一份规则也能由模型主动查 project_context 取回，作用域规则只有查对应目录才拿得到。')

  await harness.agent.send(fixture.tasks[0], { onToolResult: result => observations.push({ name: result.name, value: result.value, rendered: result.renderedContent }) })

  heading('[2] 逐步输出（以下是模型当时看到的工具结果原文）')
  for (const [index, step] of steps.entries()) {
    console.log(`\n--- 第 ${index + 1} 步：${step.label} ---`)
    console.log(`→ ${step.call.name} ${JSON.stringify(step.call.arguments ?? {})}`)
    const observation = observations[index]
    console.log(`← ${observation ? step.render ? step.render(observation.value) : excerpt(observation.rendered) : '（没有对应的工具结果）'}`)
  }

  const changes = observations.find(observation => observation.name === 'task_changes')?.value as { files?: { status?: string; diff?: string }[] } | undefined
  const diff = changes?.files?.find(file => file.status === 'applied')?.diff
  const acceptance = await fixture.evaluate()
  const run = harness.root.sessions.latestRun(harness.sessionId)

  heading('[3] 判定')
  const checks: [string, boolean][] = [
    ['run 状态为 completed', run?.status === 'completed'],
    ['task_changes 给出非空确认 diff', typeof diff === 'string' && diff.trim().length > 0],
    ['独立验收通过，且受保护文件一个未动', acceptance.passed && acceptance.exitCode === 0 && !acceptance.protectedFilesChanged.length],
  ]
  for (const [label, ok] of checks) console.log(`  ${ok ? '✓' : '✗'} ${label}`)
  console.log(`  独立验收原始输出 ${JSON.stringify(acceptance.output.trim())}，退出码 ${acceptance.exitCode}，受保护文件变更 ${JSON.stringify(acceptance.protectedFilesChanged)}`)
  console.log('  这一步在工作区之外、用独立的 verify.mjs 跑，Harness 与模型都看不到它的用例。')
  console.log("  注意 task_report 的 acceptance 恒为 'not_asserted'：通过声明的检查从不等价于任务验收。")
  console.log(`  事件日志：${path.join(sessionDirectory, harness.sessionId, 'events.jsonl')}`)
  failed = checks.some(([, ok]) => !ok)
} catch (error) {
  failed = true
  console.error(`第一幕失败：${error instanceof Error ? error.message : String(error)}`)
} finally {
  await harness.dispose()
}
if (failed) process.exitCode = 1
