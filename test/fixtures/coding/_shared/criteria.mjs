// NX-39 新增两个种类的**共同判据实现**。每个 fixture 的 verify.mjs 只有两行——把 import.meta.url
// 交给这里，于是判据只有一份实现，门禁测试可以直接对它跑正例与反例，而不必为每个 fixture 重写一套
// 复制与运行的逻辑。
//
// 两个种类的共同形状是「同一份产物在几份不同的源码上各跑一次」，判据全部落在**退出码**上：
//   repro    原始缺陷上必须**非零**、reference/ 上必须**恰好 0**（FAIL_TO_PASS）
//   mutation 原始源码上必须**恰好 0**、杀掉 ≥ minKilled 个变异体、且**不杀**行为保持的等价体
// 只读退出码有一条直接的好处：两种偷懒写法都过不了——恒 0 在缺陷上不退非零，恒非零在参考实现上不退 0。
//
// 判据本身留在工作区之外（R-23），中间产物落在 reportDirectory 里。它的生命周期由 Harness 负责
// （evaluate 每次开跑前清空、fixture 关闭时随临时目录一起删除），这里因此不自己管临时目录，
// 也就没有「忘了清理」这条失败路径，且 reportDirectory 在工作区之外，不会混进受保护文件的字节比对。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 与 coding-fixtures.ts 的 fixtureProcessTimeoutMs / maxOutputBytes 同值：一次产物运行被吊死或刷屏，
// 都该判失败，而不是把验收器本身一起拖垮。
const processTimeoutMs = 30_000
const maxOutputBytes = 32 * 1024

// 运行产物。**spawn 失败（超时、被 maxBuffer 掐掉）与「退出码非零」必须可区分**：前者的 exitCode 记
// null，而两个判据都要求某一次运行**恰好**为 0，因此 null 永远不会被当成成功。
function run(entry, cwd) {
  const result = spawnSync(process.execPath, [entry], { cwd, encoding: 'utf8', timeout: processTimeoutMs, maxBuffer: maxOutputBytes, windowsHide: true })
  const output = Buffer.from([result.error?.message, result.stdout, result.stderr].filter(Boolean).join('\n')).subarray(0, maxOutputBytes).toString('utf8')
  return { exitCode: result.error ? null : result.status, output }
}

// 复制整份工作区（含 agent 新建的产物），再按需覆盖一层源码。复制到 reportDirectory 下而不是
// os.tmpdir()：生命周期跟着 fixture 走，验收器里不必再写第二套清理逻辑。
function copyInto(source, target, overlay) {
  fs.rmSync(target, { recursive: true, force: true })
  fs.cpSync(source, target, { recursive: true })
  if (overlay !== undefined && fs.existsSync(overlay)) fs.cpSync(overlay, target, { recursive: true })
  return target
}

// 未实现的种类必须**响亮地失败**，而不是回落到某一个默认分支上静默算出一个结论。
function repro(fixtureDirectory, workspace, reportDirectory, criteria) {
  const entry = path.join(workspace, criteria.artifact)
  if (!fs.existsSync(entry)) return { kind: 'repro', artifact: criteria.artifact, initialExitCode: null, referenceExitCode: null, reason: `missing artifact: ${criteria.artifact}` }
  const defect = run(path.join(copyInto(workspace, path.join(reportDirectory, 'defect-copy')), criteria.artifact), path.join(reportDirectory, 'defect-copy'))
  const referenceCopy = copyInto(workspace, path.join(reportDirectory, 'reference-copy'), path.join(fixtureDirectory, 'reference'))
  const reference = run(path.join(referenceCopy, criteria.artifact), referenceCopy)
  return {
    kind: 'repro', artifact: criteria.artifact,
    initialExitCode: defect.exitCode, referenceExitCode: reference.exitCode,
    ...(defect.exitCode === null ? { reason: `the artifact could not run on the original sources: ${defect.output.trim().slice(0, 200)}` } : {}),
    ...(reference.exitCode !== 0 ? { reason: `the artifact did not accept the reference sources: ${reference.output.trim().slice(0, 200)}` } : {}),
  }
}

export async function verifyCriteria(verifierUrl) {
  const fixtureDirectory = path.dirname(fileURLToPath(verifierUrl))
  const [workspace, reportDirectory] = [process.argv[2], process.argv[3]]
  if (!workspace || !reportDirectory) throw new Error('usage: verify.mjs <workspace> <reportDirectory>')
  const criteria = JSON.parse(fs.readFileSync(path.join(fixtureDirectory, 'criteria.json'), 'utf8'))
  fs.rmSync(reportDirectory, { recursive: true, force: true })
  fs.mkdirSync(reportDirectory, { recursive: true })
  if (criteria.kind !== 'repro') throw new Error(`no criteria implementation for kind: ${criteria.kind}`)
  const evidence = repro(fixtureDirectory, workspace, reportDirectory, criteria)
  // 产物与判据是同一份数据的两面：report.json 是给 Harness 读的**读数**，Harness 会照它自己那套规则
  // 复算一遍通过与否。两边若不一致，说明这份判据的规则与 Harness 认定的规则已经漂移，必须失败。
  const passed = evidence.initialExitCode !== null && evidence.initialExitCode !== 0 && evidence.referenceExitCode === 0
  fs.writeFileSync(path.join(reportDirectory, 'report.json'), `${JSON.stringify({ ...evidence, passed }, null, 2)}\n`)
  if (!passed) {
    process.stderr.write(`${evidence.reason ?? `the artifact accepted the original sources (exit ${evidence.initialExitCode})`}\n`)
    process.exit(1)
  }
  console.log(`acceptance passed: ${path.basename(fixtureDirectory)}`)
}
