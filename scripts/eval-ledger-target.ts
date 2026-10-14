import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { derivePruningTarget, ledgerRunPeaks } from './eval-cli.js'
import type { LedgerRunRecord } from './eval-cli.js'

// NX-38 批次 A 的施工工具：读第一臂（ledgerA1，不裁剪）的证据，按预注册写死的规则现算第二臂（ledgerA2）
// 的裁剪目标，并打印一条可直接粘贴的命令行——转写风险靠它消除，规则本身不靠人算。
//
// **它只读层 A 的处理量（峰值估算输入），绝不读 report.json、也绝不打印 accepted。** 预注册要求
// 「目标冻结之前不得读任一臂的 accepted」：读到结局再定目标就是按结果挑仪器。这也是它读 runs.jsonl
// 而不读 report.json 的原因——后者带着 accepted 与 rate。
//
// 运行：pnpm eval:ledger-target [证据目录]   默认 .eval-evidence/ledgerA1-full
const repository = fileURLToPath(new URL('../../', import.meta.url))
const directory = process.argv[2] ?? path.join(repository, '.eval-evidence', 'ledgerA1-full')
const runLog = path.join(directory, 'runs.jsonl')
if (!fs.existsSync(runLog)) {
  console.error(`找不到 ${runLog}`)
  console.error('先跑 `pnpm eval:screening --phase ledgerA1` 把基线落盘，再回来算目标。')
  process.exit(1)
}
const records = fs.readFileSync(runLog, 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as LedgerRunRecord)
const peaks = ledgerRunPeaks(records, 'ledgerA1')
const target = derivePruningTarget(peaks)
console.log(`证据：${runLog}（${records.length} 次运行）`)
console.log(`逐次峰值估算输入：${peaks.join(' / ')}`)
console.log(`全序列峰值：${Math.max(...peaks)}；A2 目标 = floor(峰值 × 0.75) = ${target}`)
console.log('本次只读了层 A 的处理量，未读任何 accepted。')
console.log('')
console.log('粘贴下面这条命令（目标一旦冻结，跑 A2 之前不得再改）：')
console.log(`  pnpm eval:screening --phase ledgerA2 --input-target ${target}`)
