import { Context } from '@deepseek-ai/cordis'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { evalPolicy } from '../../dist/scripts/eval-runner.js'
import { assertToolProtocol } from '../../dist/src/core/context-runtime.js'
import * as sessions from '../../dist/src/plugins/session.js'
import * as systemPrompt from '../../dist/src/plugins/system-prompt.js'
import * as tools from '../../dist/src/plugins/tools.js'
import * as llm from '../../dist/src/plugins/llm.js'
import * as agents from '../../dist/src/plugins/agent.js'
import * as agentLoop from '../../dist/src/plugins/agent-loop.js'
import * as sandbox from '../../dist/src/plugins/sandbox.js'
import * as files from '../../dist/src/tools/files.js'
import * as bash from '../../dist/src/tools/bash.js'

// NX-08e0-3 诊断探针，与 review-probes.mjs / nx17-gate-probes.mjs 同类：不是回归断言，不参与
// pnpm check / pnpm test / CI 门禁。pnpm build 之后 node 直接跑。
//
// 要回答的问题：对照 A 需要会话里存在已结束且可裁剪的旧任务，且这些旧任务的累计规模足以让容量判定
// 为假。那么「多阶段 fixture 每个阶段要多大、要几个阶段」才有意义？这里把它量出来。
//
// 本探针只调用本地模拟适配器（只回一句话，不调任何工具），因此测到的是**协议与载荷开销**，不是真实
// 模型的轨迹；真实模型每个任务的工具流量要大得多（筛查跑单任务峰值 17,220、merge 烟测 27,147）。
// 探针给出的是「每阶段历史规模 → 触发裁剪所需阶段数」的换算表，真实阶段规模由筛查跑的数据代入。

// 栈与 scripts/eval-fixture.ts 一致：多注册 tools/files/bash 是为了让工具 schema 也计入估算，
// 与评测路径的请求载荷对齐。工作区用临时目录，探针结束后删除；适配器不调工具，因此不会写任何东西。
async function sweep({ payloadChars, maxStages }) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-dsh-probe-'))
  const root = new Context()
  try {
    for (const plugin of [sessions, systemPrompt, tools, llm, agents, agentLoop]) await root.plugin(plugin)
    await root.plugin(sandbox, { workspace, autoApprove: true })
    await root.plugin(files); await root.plugin(bash)
    root.llm.register('probe', {
      models: ['reply'],
      capabilities: { reply: { contextWindowTokens: 1_000_000 } },
      chat: async ({ messages = [] }) => { assertToolProtocol(messages); return { content: 'probe reply' } },
    })
    const session = root.sessions.create({ source: 'nx08e-probe' })
    const agent = root.agents.create({ sessionId: session.id, model: 'probe/reply', loop: root.agentLoop, budget: evalPolicy })
    const stage = 'x'.repeat(payloadChars)
    const rows = []
    for (let index = 1; index <= maxStages; index += 1) {
      let stopReason
      try {
        await agent.send(stage)
      } catch (cause) {
        stopReason = cause instanceof Error && 'reason' in cause ? cause.reason : String(cause)
      }
      const state = root.sessions.latestRun(session.id)
      const projection = root.sessions.visibleEvents(session.id).filter(event => event.type === 'context/projection').at(-1)
      rows.push({
        stage: index,
        input: projection?.data.estimatedInputTokens ?? 0,
        removed: projection?.data.removedTaskIds.length ?? 0,
        status: state?.status ?? 'unknown',
        stopReason,
      })
      // 触发裁剪或撞上容量上界就停：两种情况下再往下发阶段的结论都一样。
      if (rows.at(-1).removed > 0 || stopReason !== undefined) break
    }
    return rows
  } finally {
    await root.fiber.dispose()
    fs.rmSync(workspace, { recursive: true, force: true })
  }
}

// 0.3 token/ASCII 字符是 PLAN 里估算器的初值；这里只用来选载荷长度，实际规模一律以实测的
// estimatedInputTokens 为准，所以下面每行都打印实测值而不是反推值。
const charsFor = tokens => Math.round(tokens / 0.3)

const sizes = [2_000, 8_000, 32_000]

console.log('NX-08e0-3 裁剪触发规模探针（本地模拟适配器，不调真实模型，不执行任何工具）')
console.log(`预算：pnpm eval:screening 使用的 evalPolicy，输入目标 ${evalPolicy.inputTargetTokens}、窗口按端点声明 1000000、每段最多 ${evalPolicy.maxModelRequests} 次模型请求`)

const baseline = await sweep({ payloadChars: 1, maxStages: 1 })
console.log(`\n固定开销（system + 工具 schema + 一条最小 user 消息）：${baseline[0].input} token`)
console.log('这是每个请求的地板，不随阶段数变化；阶段历史叠加在它之上。')

console.log('\n每阶段载荷   阶段  实测估算输入  增量  已裁剪任务  状态')
for (const size of sizes) {
  const rows = await sweep({ payloadChars: charsFor(size), maxStages: 40 })
  let previous = 0
  for (const row of rows) {
    const marker = row.removed > 0 ? '  ← 裁剪在此触发' : row.stopReason ? `  ← ${row.stopReason}` : ''
    console.log(`${String(size).padStart(10)}   ${String(row.stage).padStart(4)}   ${String(row.input).padStart(11)}   ${String(row.input - previous).padStart(5)}   ${String(row.removed).padStart(9)}   ${row.status}${marker}`)
    previous = row.input
  }
  const first = rows.find(row => row.removed > 0)
  const overflow = rows.find(row => row.stopReason === 'context_overflow')
  if (first) console.log(`${String(size).padStart(10)}   → 第 ${first.stage} 个阶段开始裁剪，此时估算输入 ${first.input}，裁剪 ${first.removed} 个旧任务`)
  else if (overflow) console.log(`${String(size).padStart(10)}   → 单阶段自身已越过 ${evalPolicy.inputTargetTokens}，当前 task 不参与裁剪，直接 context_overflow`)
  else console.log(`${String(size).padStart(10)}   → ${rows.length} 个阶段内未触发裁剪`)
}

console.log('\n读法：把某个阶段的实测历史规模代入「每阶段载荷」列，即可得到同量级阶段需要几个才触发裁剪。')
console.log('触发裁剪那一行的增量显示为 0：裁剪把最旧的整个任务移除后，输入回到上一阶段的水平，之后会话进入')
console.log('「每新增一个阶段就丢掉最旧的一个」的滚动状态——这正是对照 A 里两臂开始分叉的位置。')
console.log('现有 fixture 的真实单任务峰值：筛查跑 12 个 fixture 最大 17,220、NX-08d0-3 的 merge 烟测 27,147（均含真实工具流量）。')
console.log('按此换算，同量级的阶段约需 3～4 个才能越过 65,536；最终阶段数由多阶段 fixture 的实际工具流量决定，以真实测量为准。')
