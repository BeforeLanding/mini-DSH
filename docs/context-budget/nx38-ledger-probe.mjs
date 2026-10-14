import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { evalPolicy } from '../../dist/scripts/eval-runner.js'
import { runFixtureTask } from '../../dist/scripts/eval-fixture.js'
import { assertToolProtocol } from '../../dist/src/core/context-runtime.js'

// NX-38-2 诊断探针，与 nx08e-prune-probe.mjs / nx08f-output-probe.mjs 同类：不是回归断言，不参与
// pnpm check / pnpm test / CI 门禁。pnpm build 之后从仓库根 `node docs/context-budget/nx38-ledger-probe.mjs`。
//
// 装置与 test/nx38-covenant.test.ts 两条用例相同，这里把数值并排打出来供人核对与回填文档。改一处要同时改
// 另一处（用例钉行为，探针给读数）。
//
// 要回答的问题：一台判据载体在**会话历史**里的仪器，离线能不能证明「它被拿掉之后，结局真的分叉」？
// 下面把两条路分开量——裁剪（移除最旧的完整任务）与压缩（模型自己写摘要替换掉一段历史）。
//
// 测到的是 **Harness 的机制**，不是模型能力：摘要正文是探针写死的，真实模型会写什么由 NX-38-4 的付费跑
// 回答。谁都不要把这里的结论写成「真实模型下也一样」。

const WINDOW = 1_000_000
const STAGE_FILES = ['src/parse.mjs', 'src/summarize.mjs', 'src/render.mjs', 'src/checksum.mjs']
const MARK = '绝对值'
const COMPACTION_MARK = '上面的对话正在被摘要'
const naive = fs.readFileSync(new URL('../../test/fixtures/coding/ledger/naive/src/checksum.mjs', import.meta.url), 'utf8')

const SUMMARY_WITHOUT = [
  '## Primary Request', '按 docs/SPEC.md 逐阶段实现「流水 → 台账」导出工具。',
  '## Files and Code', 'src/parse.mjs、src/summarize.mjs、src/render.mjs 已按阶段落地。',
  '## Next Step', '实现 src/checksum.mjs 的 checksum(entries)。',
].join('\n')
const SUMMARY_WITH = SUMMARY_WITHOUT + '\n## Critical Context\nchecksum 的口径：金额换算成分为单位的整数、取绝对值、再求和。'

function probeAdapter(fixture, probe, summary) {
  let stage = -1
  let queue = []
  return {
    provider: 'scripted', model: 'fixture', capabilities: { fixture: { contextWindowTokens: WINDOW } },
    chat: async ({ messages = [] }) => {
      assertToolProtocol(messages)
      const users = messages.filter(message => message.role === 'user').map(message => String(message.content ?? ''))
      if (users.some(content => content.includes(COMPACTION_MARK))) { probe.summarised += 1; return { content: summary } }
      const visible = users.some(content => content.includes(MARK))
      const at = fixture.tasks.reduce((found, task, index) => users.includes(task) ? index : found, -1)
      if (at < 0) return { content: '(nothing to do)' }
      if (at !== stage) {
        stage = at
        probe.seen.push({ stage: at, visible })
        const target = STAGE_FILES[at]
        const edit = fixture.edits.find(candidate => candidate.path === target)
        const newText = at === STAGE_FILES.length - 1 && !visible ? naive : edit.newText
        queue = [
          { id: `read-${at}`, name: 'read_file', arguments: { path: target } },
          { id: `write-${at}`, name: 'edit_file', arguments: { path: target, oldText: edit.oldText, newText } },
        ]
      }
      return queue.length ? { toolCalls: [queue.shift()] } : { content: `stage ${at + 1} finished` }
    },
  }
}

const run = async (budget, summary) => {
  const probe = { seen: [], summarised: 0 }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nx38-ledger-'))
  const outcome = await runFixtureTask('ledger', fixture => probeAdapter(fixture, probe, summary), budget, directory)
  const [session] = fs.readdirSync(directory)
  const events = fs.readFileSync(path.join(directory, session, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  fs.rmSync(directory, { recursive: true, force: true })
  return {
    outcome, probe,
    applied: events.filter(event => event.type === 'context/summary-end' && event.data.outcome.kind === 'applied').length,
  }
}
const peakOf = outcome => Math.max(...(outcome.tasks ?? []).map(stage => stage.maxEstimatedInputTokens ?? 0))
const report = (label, result) => {
  const { outcome, probe, applied } = result
  console.log([
    label.padEnd(30),
    `accepted=${String(outcome.accepted).padEnd(5)}`,
    `请求=${String(outcome.counters.modelRequests).padStart(3)}`,
    `压缩=${String(applied).padStart(2)}`,
    `口径可见=${probe.seen.map(entry => entry.visible ? 'Y' : 'N').join('')}`,
    `逐阶段峰值=${(outcome.tasks ?? []).map(stage => stage.maxEstimatedInputTokens ?? '-').join('/')}`,
    `裁掉任务=${(outcome.tasks ?? []).reduce((total, stage) => Math.max(total, stage.removedTaskIds.length), 0)}`,
  ].join(' '))
}

console.log('NX-38-2 判据载体探针（本地脚本化适配器，不调真实模型）')
console.log('预算取 evalPolicy，只改输入目标与（裁剪档另加的）主动压缩阈值\n')

const noPrune = { ...evalPolicy, inputTargetTokens: WINDOW, compactionBudgetTokens: WINDOW }
const baseline = await run(noPrune, SUMMARY_WITH)
console.log('── 裁剪路径：两档都关掉主动压缩，被测量的因此只是「投影按 task 移除最旧的完整任务」 ──')
report('A 无裁剪档（压缩关）', baseline)
const peak = peakOf(baseline.outcome)
const target = Math.floor(peak * 0.75)
console.log(`   目标由实测现算：全序列峰值 ${peak} 的 3/4 → ${target}`)
const pruning = await run({ ...noPrune, inputTargetTokens: target }, SUMMARY_WITH)
report(`P 裁剪档 t=${target}（压缩关）`, pruning)

console.log(`\n── 压缩路径：走生产默认（compactionBudgetTokens 缺省 = inputTargetTokens，阈值 = 目标 × 0.8） ──`)
console.log(`   两次运行预算逐字相同，只有模型自己写的摘要差一行`)
report(`C 压缩档 摘要不含口径`, await run({ ...evalPolicy, inputTargetTokens: target }, SUMMARY_WITHOUT))
report(`C 压缩档 摘要含口径  `, await run({ ...evalPolicy, inputTargetTokens: target }, SUMMARY_WITH))

console.log('\n读法：')
console.log('· 「口径可见」逐阶段读：Y 表示模型此刻的请求里还带着那条口径。裁剪档把它从 Y 变成 N，')
console.log('  而两档的其余配置逐字段相同，所以结局的分叉只能归因到这一件事。')
console.log('· 压缩只在当前 task 内部规划，动不到任何阶段的说明——所以它不是丢失的来源，而是模型的自救通道：')
console.log('  摘要把口径带下去，裁掉之后它仍然可见（最后一行 = Y），结局跟着绿。')
console.log('· 这一条**不是**模型能力证据。真实模型会不会丢、会怎么写摘要，要另外花钱去问（NX-38-4）。')
