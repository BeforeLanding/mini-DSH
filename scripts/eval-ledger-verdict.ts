import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { batchArms, classifyBatch } from './eval-classify.js'
import type { ArmRun, BatchName } from './eval-classify.js'
import type { LedgerPhase } from './eval-runner.js'

// 把 NX-38-3 预注册的四类判据跑成一条命令：读两臂各自的 runs.jsonl，按固定顺序判定并逐条给出理由。
// 它存在的理由是让 eval-classify.ts 的纯函数有真实调用者——判定不该只活在测试里。
//
// 运行：pnpm eval:ledger-verdict A|B [证据根目录]   默认根目录 .eval-evidence
const batch = process.argv[2]
if (batch !== 'A' && batch !== 'B') {
  console.error('用法：pnpm eval:ledger-verdict A|B [证据根目录]')
  process.exit(1)
}
const repository = fileURLToPath(new URL('../../', import.meta.url))
const root = process.argv[3] ?? path.join(repository, '.eval-evidence')
const evidence = {} as Record<LedgerPhase, ArmRun[]>
const missing: string[] = []
for (const phase of batchArms[batch as BatchName]) {
  const runLog = path.join(root, `${phase}-full`, 'runs.jsonl')
  if (!fs.existsSync(runLog)) { missing.push(runLog); evidence[phase] = [] } else {
    evidence[phase] = fs.readFileSync(runLog, 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as ArmRun)
  }
}
if (missing.length) {
  console.error(`缺证据：\n  ${missing.join('\n  ')}`)
  console.error(`先跑该批的两条臂：${batchArms[batch as BatchName].map(phase => `pnpm eval:screening --phase ${phase}`).join('；')}`)
  process.exit(1)
}
const verdict = classifyBatch(batch as BatchName, evidence)
console.log(`批次 ${verdict.batch}：${verdict.verdict}`)
for (const arm of verdict.arms) {
  console.log(`  ${arm.phase}：${arm.state}；峰值 ${arm.peaks.join(' / ') || '(无)'}；accepted ${arm.accepted.map(value => String(value)).join(' / ') || '(无)'}`)
}
for (const reason of verdict.reasons) console.log(`  - ${reason}`)
