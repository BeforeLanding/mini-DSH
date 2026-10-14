import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { historicalCategories } from './coding-fixtures.js'
import { classifyAblation, reportExitCode, summarizeCell } from './eval-aggregate.js'
import type { CellRun, CellSummary } from './eval-aggregate.js'
import { ablationPhases, phaseCaps } from './eval-runner.js'
import type { AblationPhase } from './eval-runner.js'

// 聚合器的调用者：读四格各自的 `runs.jsonl`，按预注册的口径打印分类别成功率、触顶率、因子触发率与六类
// 指标，再给出层 A／层 B 的判定。判定与读数分开（读数在 eval-aggregate.ts 里），是因为判定必须**只有
// 一处实现**——报告里手写一遍「这台仪器立起来没有」，两处迟早会漂开。
//
// 运行：pnpm eval:ablation-report [证据根目录]   默认根目录 .eval-evidence
// 退出码：0 = 读到了完整证据并给出判定；1 = 缺证据、一次运行都没跑成、或有格未跑满。**禁止静默跳过**：
// 「什么都没跑」与「跑完了，四格都一样」必须区别对待，否则一次没跑成的批次会以「天花板未破」的形状出现。
const repository = fileURLToPath(new URL('../../', import.meta.url))
const root = process.argv[2] ?? path.join(repository, '.eval-evidence')

const missing: string[] = []
const evidence = {} as Record<AblationPhase, CellRun[]>
for (const phase of ablationPhases) {
  const runLog = path.join(root, `${phase}-full`, 'runs.jsonl')
  if (!fs.existsSync(runLog)) { missing.push(runLog); evidence[phase] = []; continue }
  evidence[phase] = fs.readFileSync(runLog, 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as CellRun)
}
if (missing.length) {
  console.error(`缺证据：\n  ${missing.join('\n  ')}`)
  console.error(`先跑该格：${ablationPhases.map(phase => `pnpm eval:screening --phase ${phase}`).join('；')}`)
  process.exit(1)
}

const cells = ablationPhases.map(phase => summarizeCell(phase, phaseCaps[phase].runs, evidence[phase]))
print(cells)
const reading = classifyAblation(cells)
console.log(`\n判定：${reading.verdict}`)
for (const reason of reading.reasons) console.log(`  - ${reason}`)

// 「禁止静默跳过」的判定只有一处实现（eval-aggregate 的 reportExitCode），这里不另写一遍。
process.exitCode = reportExitCode(cells)

function print(cells: readonly CellSummary[]) {
  console.log(`证据根目录：${root}`)
  console.log('\n成功率（分子／分母 = 通过／可计分；后两类的分母只有 4 项 × 3 遍）')
  const header = ['类别', ...cells.map(cell => cell.phase)]
  console.log(header.join('\t'))
  const categories = cells[0]?.rates.map(rate => rate.category) ?? []
  for (const category of categories) {
    const row = cells.map(cell => {
      const rate = cell.rates.find(item => item.category === category)
      return rate === undefined ? '(无)' : `${rate.accepted}/${rate.denominator}（跑 ${rate.runs}）`
    })
    console.log([cells[0]?.rates.find(rate => rate.category === category)?.label ?? category, ...row].join('\t'))
  }
  // 前三类与后两类必须分开呈现，且哪个是哪个只有一处定义（coding-fixtures 的 historicalCategories）。
  const historical = cells[0]?.rates.filter(rate => historicalCategories.includes(rate.category)) ?? []
  const recent = cells[0]?.rates.filter(rate => !historicalCategories.includes(rate.category)) ?? []
  const group = (keep: typeof historical) => cells.map(cell => {
    const accepted = cell.rates.filter(rate => keep.some(item => item.category === rate.category)).reduce((total, rate) => total + rate.accepted, 0)
    const denominator = cell.rates.filter(rate => keep.some(item => item.category === rate.category)).reduce((total, rate) => total + rate.denominator, 0)
    return `${accepted}/${denominator}`
  })
  console.log(['前三类小计', ...group(historical)].join('\t'))
  console.log(['后两类小计', ...group(recent)].join('\t'))

  console.log('\n触顶率（分子 = 终态 token_budget ＋ 因整批上限未执行的计划 run；分母 = 计划运行数）')
  for (const cell of cells) {
    console.log(`  ${cell.phase}\t${cell.ceiling.numerator}/${cell.ceiling.denominator}\t(token_budget ${cell.ceiling.tokenBudget} ＋ 未执行 ${cell.ceiling.notExecuted})\t执行 ${cell.executed}/${cell.planned}\tcompleted ${cell.completed}\t不可行 ${cell.infeasible}\t基础设施失败 ${cell.errored}`)
  }

  console.log('\n因子触发率（分母都是该格实际执行的 run 数；多轮占比的分母是多轮 run）')
  for (const cell of cells) {
    const t = cell.triggers
    const percent = (value: number | null) => value === null ? '(无分母)' : `${(value * 100).toFixed(1)}%`
    console.log(`  ${cell.phase}\t主动压缩 ${t.pressure.triggered}/${t.pressure.runs} ${percent(t.pressure.rate)}\t预览截断 ${t.truncation.triggered}/${t.truncation.runs} ${percent(t.truncation.rate)}\t提示逐字稳定 ${t.stablePrompt.triggered}/${t.stablePrompt.multiRound} ${percent(t.stablePrompt.rate)}\tcontext_overflow ${t.contextOverflowStages} 阶段`)
  }

  console.log('\n六类指标（延迟报 p50／p95，不报合计）')
  for (const cell of cells) {
    const m = cell.metrics
    console.log(`  ${cell.phase}\t轮次 ${m.modelRounds}\t工具 ${m.toolCalls}\t工具错误 ${m.toolErrors}\t预览截断 ${m.previewTruncations}\ttoken ${m.tokens.total}(入 ${m.tokens.input}／出 ${m.tokens.output}／cache ${m.tokens.cache})\t延迟 p50 ${m.latency.p50 ?? '-'}ms p95 ${m.latency.p95 ?? '-'}ms max ${m.latency.max ?? '-'}ms（${m.latency.requests} 次请求）`)
  }
}
