import path from 'node:path'
import { createFixture } from './coding-fixtures.js'
import { assembleDemoHarness, heading } from './demo-context.js'
import { CLI_BUDGET, BudgetStop } from '../src/core/budget.js'
import { estimateInput } from '../src/core/token-estimator.js'
import { readHistory } from '../src/core/history-read.js'
import type { ChatRequest, ChatResponse } from '../src/core/contracts.js'

// NX-34 第四幕：上下文压缩。零付费——摘要由一个脚本化模型写，因此逐字可复现。
// 要看的是四件事：单任务长会话本来会以 context_overflow 停下、压缩之后它装得下、被替换掉的原文
// 仍在日志里、而且能用 read_history 按事件号逐字读回来。这四件都由断言判定，不由旁白担保。
heading('NX-34 第四幕：上下文压缩（单任务长会话，零付费）')

const fixture = await createFixture('repair')

// 摘要调用与主循环调用要能分开认：摘要调用一眼可辨——它的最后一条消息就是那条固定指令。
const SUMMARY_MARK = '上面的对话正在被摘要'
const isSummaryCall = (request: ChatRequest): boolean =>
  typeof request.messages?.at(-1)?.content === 'string' && request.messages!.at(-1)!.content!.includes(SUMMARY_MARK)

let summaries = 0
let mainCalls = 0
const scripted = () => ({
  provider: 'scripted', model: 'demo', capabilities: { demo: { contextWindowTokens: 1_000_000 } },
  chat: async (request: ChatRequest): Promise<ChatResponse> => {
    if (isSummaryCall(request)) {
      summaries += 1
      return { content: '## Primary Request\n- repair cart total\n\n## Files and Code\n- src/cart.mjs total()\n\n## Pending Work\n- rerun node check.mjs' }
    }
    mainCalls += 1
    return { content: '脚本化模型：这一轮不该被调用' }
  },
})

// 一条**单任务**长会话：原始请求 + 一段长工具链 + 尾巴。既有裁剪只移除已结束的旧任务、当前 task 恒受
// 保护，所以真正会撑爆上下文的就是这种会话——压缩要压的正是它。
const CONSTRAINT = 'constraint: never edit src/secret.ts; always rerun node check.mjs'
// 大小刻意选在「压得动，又装得下一页」之间：它单独就超过输入目标，但默认 16 KiB 一页装得下整条。
// 单条事件**大于一整页**时 read_history 按 (nextSeq, nextOffset) 游标分页续读——那是另一条分支，
// 由 test/history-read.test.ts 钉住，不混进这一幕。
const toolText = ['// cart.mjs', ...Array.from({ length: 350 }, () => 'const line = "the call site is here";')].join('\n')
// 窗口显式给出 1M：默认配置下压缩阈值（输入目标的 80%）在家用小历史上够不着，演示要让它可达。
const policy = { ...CLI_BUDGET, inputTargetTokens: 3000, contextWindowTokens: 1_000_000 }
const harness = await assembleDemoHarness(fixture, scripted, {
  budget: policy,
  sessionDirectory: path.join('.demo-runs', 'demo-compact'),
})
const root = harness.root
const sessionId = harness.sessionId
let failed = false

try {
  const run = root.sessions.beginRun(sessionId, policy, 'scripted/demo')
  const request = root.sessions.append(sessionId, 'user/message', { content: 'repair the cart total and keep the public check green' }, run)
  root.sessions.append(sessionId, 'assistant/message', { content: `noted. ${CONSTRAINT}` }, run)
  root.sessions.append(sessionId, 'assistant/tool_calls', { toolCalls: [{ id: 'read', name: 'read_file', arguments: { path: 'src/cart.mjs' } }] }, run)
  root.sessions.append(sessionId, 'tool/result', { toolCallId: 'read', name: 'read_file', content: toolText }, run)
  root.sessions.append(sessionId, 'assistant/message', { content: 'tail: I am about to change total()' }, run)
  root.sessions.finishRun(run, 'max_steps')
  // 等落盘排空：`latestRun` 把「run/finish 已写但还没确认」读成 running，那会让 /compact 撞上
  // 「session is already running」。演示走的是真实路径，这一点也不该被抹掉。
  await root.sessions.flush(sessionId)

  const project = () => {
    const messages = root.sessions.deriveMessages(sessionId)
    return { messages, tokens: estimateInput({ system: 'demo', messages, tools: [] }) }
  }
  const before = project()
  heading('[1] 压缩之前')
  console.log(`  投影 ${before.messages.length} 条消息、约 ${before.tokens} 估算 token（输入目标 ${policy.inputTargetTokens}）`)
  console.log(`  其中最长的一条是工具结果，${toolText.length} 字符——既有裁剪救不了它：当前 task 恒受保护`)

  heading('[2] /compact：一次摘要调用')
  const applied = await root.agentLoop.compact(harness.agent, { budget: policy })
  const after = project()
  const summary = root.sessions.visibleEvents(sessionId).find(event => event.type === 'context/summary')
  console.log(`  结果 applied=${applied}，摘要调用 ${summaries} 次，主循环调用 ${mainCalls} 次`)
  if (summary?.type === 'context/summary') {
    console.log(`  替换掉 ${summary.data.shadowedSeqs.length} 条事件（${summary.data.shadowedTokens} 估算 token），写入摘要 ${summary.data.summaryTokens} token，保留尾部 ${summary.data.retainedNodes} 条`)
    console.log(`  被替换的 seq：${JSON.stringify(summary.data.shadowedSeqs)}`)
  }
  console.log(`  投影 ${after.messages.length} 条消息、约 ${after.tokens} 估算 token`)

  heading('[3] frame 落在哪、原文还在不在')
  const frame = after.messages.find(message => message.content?.startsWith('<system-reminder>'))
  const requestIndex = after.messages.findIndex(message => message.content?.includes('repair the cart total'))
  console.log(`  frame 在投影里的位置：第 ${after.messages.indexOf(frame!) + 1} / ${after.messages.length} 条；原始用户请求在第 ${requestIndex + 1} 条`)
  console.log(`  frame 提到了 read_history：${frame?.content?.includes('read_history') === true}`)
  const kept = root.sessions.visibleEvents(sessionId).flatMap(event => event.type === 'tool/result' ? [event.data.content] : [])
  console.log(`  被替换掉的工具结果仍完整躺在日志里：${kept.length} 条，${kept[0]?.length ?? 0} 字符`)

  heading('[4] 按事件号把原文读回来')
  const shadowed = summary?.type === 'context/summary' ? summary.data.shadowedSeqs : []
  const pages: string[] = []
  // 游标是一对 (nextSeq, nextOffset)。只跟 nextSeq 会在超大事件上原地打转——这里按正确用法走，
  // 并且把每页末尾那句「继续读」的提示语剥掉再拼，因为提示语是插在页面之间的，不属于任何事件的原文。
  let from = shadowed[0] ?? 1
  let offset = 0
  let guard = 0
  while (guard++ < 50) {
    const page = readHistory(root.sessions, sessionId, from, undefined, undefined, undefined, offset)
    pages.push(page.content)
    if (page.eof) break
    from = page.nextSeq
    offset = page.nextOffset
  }
  const whole = pages.map(text => text.replace(/\n\[truncated; continue with read_history from=\d+ offset=\d+\]/g, '')).join('')
  console.log(`  read_history({from:${shadowed[0] ?? 1}}) 分 ${pages.length} 页、共 ${whole.length} 字符`)
  console.log(`  约束原文读得回来：${whole.includes(CONSTRAINT)}`)
  console.log(`  那条 ${toolText.length} 字符的工具结果逐字读得回来：${whole.includes(toolText)}`)
  console.log('  （默认一页 16 KiB；一页绝不在中途把事件劈成两半，装不下整条时停在它之前；单条事件自己超过一页时，')
  console.log('    给出有界前缀并把游标停在它身上，下一次调用带着 nextOffset 接着读——一个字节都不会丢。）')

  heading('[5] 判定')
  const checks: [string, boolean][] = [
    ['压缩确实应用了', applied === true],
    ['摘要只花了一次模型调用，主循环一次都没跑', summaries === 1 && mainCalls === 0],
    ['投影变小了', after.tokens < before.tokens],
    ['被替换段不含原始用户请求', shadowed.length > 0 && !shadowed.includes(request.seq)],
    ['frame 紧跟在原始用户请求之后', requestIndex >= 0 && after.messages.indexOf(frame!) === requestIndex + 1],
    ['frame 提到了 read_history（该部署确实挂载了它）', frame?.content?.includes('read_history') === true],
    ['被遮蔽的工具结果一条没删、长度不变', kept.length === 1 && kept[0] === toolText],
    ['约束原文可逐字读回', whole.includes(CONSTRAINT)],
    ['被替换的工具结果也可逐字读回', whole.includes(toolText)],
  ]
  for (const [label, ok] of checks) console.log(`  ${ok ? '✓' : '✗'} ${label}`)
  console.log(`  事件日志：${path.join('.demo-runs', 'demo-compact', sessionId, 'events.jsonl')}`)
  failed = checks.some(([, ok]) => !ok)
} catch (error) {
  failed = true
  console.error(`第四幕失败：${error instanceof BudgetStop ? `预算停止 ${error.reason}` : error instanceof Error ? error.message : String(error)}`)
} finally {
  await harness.dispose()
}
if (failed) process.exitCode = 1
