import fs from 'node:fs/promises'
import { parseLog } from '../src/core/event-store.js'
import { TokenObservationCollector, calibrateTokenEstimate } from '../src/core/token-calibration.js'

// R06 阶段 A 的独立入口：只读 JSONL，不调用模型、不写会话目录。usage.source 不是 provider 的记录
// 一律单列，不参与误差统计；阶段 B 校准只有显式加 --apply-calibration 才算，默认保持关闭。
async function main() {
  const args = process.argv.slice(2)
  const files = args.filter(argument => !argument.startsWith('--'))
  const json = args.includes('--json')
  const applyCalibration = args.includes('--apply-calibration')
  if (!files.length) {
    console.error('usage: report-token-error <events.jsonl> [...] [--json] [--apply-calibration]')
    process.exitCode = 2
    return
  }
  const collector = new TokenObservationCollector()
  for (const file of files) {
    const text = await fs.readFile(file, 'utf8')
    const firstLine = text.slice(0, text.indexOf('\n'))
    let sessionId: unknown
    try { sessionId = JSON.parse(firstLine).sessionId } catch { throw new Error(`${file}: missing or invalid first JSONL record`) }
    if (typeof sessionId !== 'string') throw new Error(`${file}: first record has no sessionId`)
    for (const event of parseLog(text, sessionId)) collector.observe(event)
  }
  const summary = collector.summary()
  const calibration = calibrateTokenEstimate(collector.observations(), { enabled: applyCalibration })
  if (json) {
    console.log(JSON.stringify({ files, tokenError: summary, calibration }, null, 2))
    return
  }
  const percent = (value: number) => `${(value * 100).toFixed(2)}%`
  console.log(`Files: ${files.length}; estimator ${summary.estimatorVersion}; provider samples: ${summary.samples}`)
  console.log(`Relative error (estimated-actual)/actual: median ${percent(summary.medianRelativeError)}; underestimate ${percent(summary.underestimateRate)}; |error| p50 ${percent(summary.p50AbsRelativeError)} / p95 ${percent(summary.p95AbsRelativeError)}`)
  for (const group of summary.groups) {
    console.log(`  ${group.kind} model=${group.model} schema=${group.schemaDigest.slice(0, 12)} samples=${group.samples} median=${percent(group.medianRelativeError)} underestimate=${percent(group.underestimateRate)} |error| p50=${percent(group.p50AbsRelativeError)} p95=${percent(group.p95AbsRelativeError)}`)
  }
  const excluded = summary.excluded
  console.log(`Excluded: missing usage ${excluded.missingUsage}, estimated usage ${excluded.estimatedUsage}, zero actual ${excluded.actualZero}, orphan usage ${excluded.orphanUsage}, rejected ${excluded.rejected}, duplicate usage ${excluded.duplicateUsage}, missing estimate ${excluded.missingEstimate}`)
  if (applyCalibration) console.log(`Calibration: ${calibration.reason}; samples ${calibration.samples}/${calibration.windowSamples}; ratio ${calibration.ratio?.toFixed(4) ?? 'n/a'}; multiplier ${calibration.multiplier.toFixed(4)}`)
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
