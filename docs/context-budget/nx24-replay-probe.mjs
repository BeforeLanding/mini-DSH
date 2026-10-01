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
// 9 条 `path escapes the workspace`）。NX-24 之后为 9 条，且这 9 条逐条有归属（见下表）。
// `.eval-evidence/` 不入库，所以这个探针只在有历史证据的工作区里可跑。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { SandboxRuntime } from '../../dist/src/core/sandbox-runtime.js'

// NX-24 收口后仍被拒的 9 条，逐条标了归属。**断言集合而不是断言计数**——以后修 NX-25/27/28/29
// 时这些条目会从这里消失，那时应当把条目删掉，而不是把断言放宽成一个数字。
const expected = new Map([
  ['7d13fdc54a', 'NX-27 写 /tmp（Git Bash 的 /tmp 与 node:path 不一致）'],
  ['c7475a2f5e', 'NX-28 here-doc 正文里形如 a:\\tb\\tc 的字面量被判为盘符路径'],
  ['d7ecbb0360', '真阳性：双引号内未转义的 $ad，bash 确实会展开'],
  ['259cab65d6', '真阳性：双引号内未转义的 $c，bash 确实会展开'],
  ['96a488b3e0', 'NX-29 正则字面量 `/missing` 与绝对根路径 `/missing` 形状完全相同'],
  ['062d867579', 'NX-18 `cat ../package.json` 的 `..` 整串正则（从 src 上一级仍在工作区内）'],
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
