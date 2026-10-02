// NX-24 回放探针：把 .eval-evidence 里**真实模型**跑过的每一次 bash 调用取出来，按**各会话自己的
// workspace** 重放到当前构建的闸门上，看还有哪些被拒、理由是什么。
//
// 这不是回归断言也不是 CI 门禁（契约住在 test/core.test.ts）。它是 NX-24 的证据生成器：判断题干
// 「闸门词法与真实 shell 不一致，把数据当成路径或变量」到底有多少条实测样本，以及每一步改完之后
// 还剩什么。
//
// 运行：`pnpm build && node docs/context-budget/nx24-replay-probe.mjs`
//
// **方法学**：workspace 必须按会话读回，不能用 process.cwd()。
// 用 process.cwd() 重放得到 64 条拒绝，其中 32 条是重放自身的伪影——模型在评测里
// `cd "C:\…\mini-dsh-fixture-*/workspace"`，而闸门的 workspace 就是那个临时目录。
// 数字会凭空翻倍，且翻倍的那一半与闸门无关。
//
// 基线：NX-24 动手前（提交 76ebadc）为 782 次调用 / 32 条拒绝（23 条 `unset environment variable`、
// 9 条 `path escapes the workspace`）。NX-24 之后为 9 条，NX-32 收缩后为 7 条（见下表）——
// 减少的两条是环境展开撤销的连带，不是修好了。`.eval-evidence/` 不入库，所以这个探针只在有历史
// 证据的工作区里可跑。
//
// 它现在是闸门的**过拒回归闸**：收缩只会让拒绝变少，所以任何新增拒绝都值得单独看一眼。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { SandboxRuntime } from '../../dist/src/core/sandbox-runtime.js'

// 仍被拒的条目，逐条标了归属。**断言集合而不是断言计数**——以后修 NX-25/27/28/29
// 时这些条目会从这里消失，那时应当把条目删掉，而不是把断言放宽成一个数字。
// **NX-18 已经改完，它那条却没有消失**：拦住 `cat ../package.json` 的不是 `..` 判据的形状，而是闸门
// 看不见命令内部的 `cd`（命令先 `cd src`）。那条缺口属 D-16 撤掉的「命令位置状态」一族，不在 NX-18
// 的范围内——所以这里**不删条目**，只订正注记，让它不再把原因错记成整串正则。
//
// NX-32（2026-10-01）：闸门收缩撤销了环境展开，两条「双引号内未转义的 `$ad`／`$c`」真阳性
// 因此不再被拒，条目按上面的规则删除——它们降级为闸门矩阵里的 `known gap NX-24 reopened`，
// 由 `nx17-gate-probes.mjs` 盯着，不在这里留一个宽松的断言。
const expected = new Map([
  ['7d13fdc54a', 'NX-27 写 /tmp（Git Bash 的 /tmp 与 node:path 不一致）'],
  ['c7475a2f5e', 'NX-28 here-doc 正文里形如 a:\\tb\\tc 的字面量被判为盘符路径'],
  ['96a488b3e0', 'NX-29 正则字面量 `/missing` 与绝对根路径 `/missing` 形状完全相同'],
  ['062d867579', 'NX-18 `cat ../package.json`：闸门不看命令内的 `cd`（命令先 `cd src`），相对 workspace 根确实越界'],
  ['52e783f9c4', 'NX-27 写 /tmp'],
  ['21c76e9675', 'NX-27 写 /tmp'],
  ['11dc755c95', 'NX-27 写 /tmp'],
])

function walk(directory, out = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) walk(target, out)
    else if (entry.name === 'events.jsonl') out.push(target)
  }
  return out
}

const evidence = '.eval-evidence'
if (!fs.existsSync(evidence)) {
  console.log(`${evidence} 不存在（它不入库）：这个探针只在带历史证据的工作区里可跑`)
  process.exit(0)
}

const fingerprint = (command) => crypto.createHash('sha1').update(command).digest('hex').slice(0, 10)

let calls = 0
const denied = new Map()
for (const file of walk(evidence)) {
  const events = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
    .map(line => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
  // 会话自己的 workspace：从任意一次 bash 的 tool/result 里读回 cwd。
  let workspace = null
  for (const event of events) {
    if (event.type !== 'tool/result' || event.data?.name !== 'bash') continue
    try { const content = JSON.parse(event.data.content); if (content?.cwd) { workspace = content.cwd; break } } catch { /* 非命令结果 */ }
  }
  const sandbox = new SandboxRuntime({ workspace: workspace ?? process.cwd(), autoApprove: true })
  for (const event of events) {
    if (event.type !== 'assistant/tool_calls') continue
    for (const call of event.data.toolCalls ?? []) {
      if (call.name !== 'bash') continue
      calls += 1
      const command = call.arguments?.command ?? ''
      try { sandbox.assertCommand(command) } catch (error) { denied.set(fingerprint(command), { reason: error.message, command, file }) }
    }
  }
}

console.log(`bash 调用 ${calls} 次，其中 ${denied.size} 次被拒（NX-24 前是 32 次）\n`)
let unexpected = 0
for (const [id, { reason, command }] of denied) {
  const note = expected.get(id)
  if (!note) unexpected += 1
  console.log(`${note ? ' ' : '!'} ${id}  ${reason}`)
  console.log(`      ${(note ?? '未登记').replace(/^\S+ /, '')}`.trimEnd())
  console.log(`      ${JSON.stringify(command.slice(0, 72))}\n`)
}
for (const [id, note] of expected) {
  if (denied.has(id)) continue
  unexpected += 1
  console.log(`! ${id} 已不再被拒——该条目应从本探针删除，而不是把断言放宽`)
  console.log(`      ${note}\n`)
}

console.log(unexpected === 0
  ? `no unexpected deny: ${denied.size} 条全部有归属`
  : `${unexpected} 条与登记不符`)
process.exit(unexpected === 0 ? 0 : 1)
