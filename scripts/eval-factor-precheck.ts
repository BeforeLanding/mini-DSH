import { ablationIds } from './coding-fixtures.js'
import { precheckFixtures, precheckVerdict, pressureThreshold, probeMechanism, probePromptLayout } from './eval-precheck.js'
import type { FixturePrecheck, PrecheckVerdict } from './eval-precheck.js'

// 离线因子预检的入口。零付费、不出网、不需要 API key：它跑的是脚本化适配器。
// 退出码 1 = **机制不成立**，R-21 的「不满足时不得开跑对照」当场生效。脚本化最小序列没触发**不算**不成立
// （那段数字是下界，见 eval-precheck.ts 的注释），因此它只打印、不拦。
const readings = await precheckFixtures()
const probe = await probeMechanism()
const layouts = await probePromptLayout()
const verdict = precheckVerdict(readings, probe, layouts)
print(readings, probe, layouts, verdict)
process.exitCode = verdict.truncationMechanism && verdict.pressureMechanism && verdict.promptLayout.liveChanges && verdict.promptLayout.frozenPinned ? 0 : 1

function print(readings: readonly FixturePrecheck[], probe: Awaited<ReturnType<typeof probeMechanism>>, layouts: Awaited<ReturnType<typeof probePromptLayout>>, verdict: PrecheckVerdict) {
  console.log(`四格任务集：${ablationIds.length} 项；主动压缩阈值 ${pressureThreshold} token（= 65,536 × 0.8）`)
  console.log('\nA. 逐 fixture 两档读数（脚本化最小序列；它是**下界**，不是对真实模型的预测）')
  console.log(['fixture', '阶段数', '关档投影', '关档峰值', '开档投影', '开档峰值', '开档压缩(主动)', '开档截断', '开档裁剪'].join('\t'))
  for (const item of readings) {
    console.log([
      item.fixture, item.on.stages,
      item.off.projections, item.off.peakEstimatedInputTokens,
      item.on.projections, item.on.peakEstimatedInputTokens,
      `${item.on.compactions.applied}(${item.on.compactions.pressure})`, item.on.previewTruncations, item.on.prunedStages,
    ].join('\t'))
  }

  console.log('\nB. 机制探针（合成驱动把历史推过阈值；两个方向都跑才算证明）')
  console.log(`  截断：有界 ${probe.bounded.previewTruncations} 次 ／ 无界 ${probe.unbounded.previewTruncations} 次\t峰值 ${probe.bounded.peakEstimatedInputTokens} / ${probe.unbounded.peakEstimatedInputTokens} token\t${verdict.truncationMechanism ? '成立' : '不成立'}`)
  console.log(`  压缩：主动出手 ${probe.bounded.compactions.pressure} 次（applied ${probe.bounded.compactions.applied}）\t${verdict.pressureMechanism ? '成立' : '不成立'}`)

  console.log('\nC. 提示布局探针（同一台驱动，两档 layout）')
  for (const layout of layouts) {
    console.log(`  ${layout.frozen ? 'frozen' : 'live  '}：轮数 ${layout.rounds}、其中与前一轮逐字相同 ${layout.stable}、不同的系统提示文本 ${layout.prompts} 份`)
  }

  console.log('\n结论')
  console.log(`  单任务项 ${verdict.singleStageFixtures}/${verdict.totalFixtures}；脚本化下界：压缩 ${verdict.scriptedPressure}/${verdict.totalFixtures}、截断 ${verdict.scriptedTruncation}/${verdict.totalFixtures}`)
  if (verdict.closestToThreshold) {
    const { fixture, peak, gap } = verdict.closestToThreshold
    console.log(`  离阈值最近的一项是 ${fixture}：峰值 ${peak}，${gap >= 0 ? `还差 ${gap}` : `已越过 ${-gap}`} token`)
  }
  for (const reason of verdict.reasons) console.log(`  - ${reason}`)
  const ok = verdict.truncationMechanism && verdict.pressureMechanism && verdict.promptLayout.liveChanges && verdict.promptLayout.frozenPinned
  console.log(`\n判定：${ok ? '机制成立，允许按预注册开跑对照（触发率仍需在付费证据上量）' : '机制不成立——按 R-21 不得开跑对照'}`)
}
