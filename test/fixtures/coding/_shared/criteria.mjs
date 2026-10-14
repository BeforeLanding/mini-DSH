// NX-39 新增两个种类的**共同判据实现**。每个 fixture 的 verify.mjs 只有两行——把 import.meta.url
// 交给这里，于是判据只有一份实现，门禁测试可以直接对它跑正例与反例，而不必为每个 fixture 重写一套
// 复制与运行的逻辑。
//
// 两个种类的共同形状是「同一份产物在几份不同的源码上各跑一次」，判据全部落在**退出码**上：
//   repro    原始缺陷上必须**非零**、reference/ 上必须**恰好 0**（FAIL_TO_PASS）
//   mutation 原始源码上必须**恰好 0**、杀掉 ≥ minKilled 个变异体、且**不杀**行为保持的等价体
// 只读退出码有一条直接的好处：两种偷懒写法都过不了——恒 0 在缺陷上不退非零（也杀不掉变异体），
// 恒非零在参考实现上不退 0（也在原始源码上失败）。
//
// mutation 的「不杀等价体」那一条是**防过拟合测试**的主要机制：想靠比对源码文本或哈希来判定
// 「这份还是不是原来那份」的产物，会把与自己文本不同的等价体一并杀掉，于是当场判失败。
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
// null。repro 要求某一次运行**恰好**为 0，因此 null 永远不会被当成成功；mutation 则把「变异体上没能
// 跑完」单独计数并判失败——超时不是「发现了一个缺陷」，把它算成杀灭会让一个会挂死的套件白拿分。
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

// 目录名按字典序排，于是读数里「第几个变异体」在同一 fixture 上稳定可复现。
function variantNames(fixtureDirectory, name) {
  const directory = path.join(fixtureDirectory, name)
  return fs.existsSync(directory) ? fs.readdirSync(directory).sort() : []
}

function repro(fixtureDirectory, workspace, reportDirectory, criteria) {
  const entry = path.join(workspace, criteria.artifact)
  if (!fs.existsSync(entry)) {
    return { evidence: { kind: 'repro', artifact: criteria.artifact, initialExitCode: null, referenceExitCode: null, reason: `missing artifact: ${criteria.artifact}` }, passed: false }
  }
  const defectCopy = copyInto(workspace, path.join(reportDirectory, 'defect-copy'), undefined)
  const defect = run(path.join(defectCopy, criteria.artifact), defectCopy)
  const referenceCopy = copyInto(workspace, path.join(reportDirectory, 'reference-copy'), path.join(fixtureDirectory, 'reference'))
  const reference = run(path.join(referenceCopy, criteria.artifact), referenceCopy)
  const evidence = {
    kind: 'repro', artifact: criteria.artifact,
    initialExitCode: defect.exitCode, referenceExitCode: reference.exitCode,
    ...(defect.exitCode === null ? { reason: `the artifact could not run on the original sources: ${defect.output.trim().slice(0, 200)}` } : {}),
    ...(reference.exitCode !== 0 ? { reason: `the artifact did not accept the reference sources: ${reference.output.trim().slice(0, 200)}` } : {}),
  }
  return { evidence, passed: evidence.initialExitCode !== null && evidence.initialExitCode !== 0 && evidence.referenceExitCode === 0 }
}

function mutation(fixtureDirectory, workspace, reportDirectory, criteria) {
  const minKilled = criteria.minKilled
  if (!Number.isSafeInteger(minKilled) || minKilled <= 0) throw new Error(`criteria.json must declare a positive integer minKilled, got ${String(minKilled)}`)
  const mutants = variantNames(fixtureDirectory, 'mutants')
  const equivalents = variantNames(fixtureDirectory, 'equivalents')
  const evidence = {
    kind: 'mutation', artifact: criteria.artifact, minKilled,
    originalExitCode: null,
    mutantsTotal: mutants.length, mutantsKilled: 0, mutantsUnrunnable: 0,
    equivalentsTotal: equivalents.length, equivalentsKilled: 0,
  }
  if (!fs.existsSync(path.join(workspace, criteria.artifact))) return { evidence: { ...evidence, reason: `missing artifact: ${criteria.artifact}` }, passed: false }
  // 每一次都在**自己的副本**上跑：产物与源码不该被这次运行改动，各个变异态的读数也互不影响。
  const exitCodeOn = (name, overlay) => {
    const copy = copyInto(workspace, path.join(reportDirectory, name), overlay)
    return run(path.join(copy, criteria.artifact), copy).exitCode
  }
  evidence.originalExitCode = exitCodeOn('original', undefined)
  for (const [index, mutant] of mutants.entries()) {
    const exitCode = exitCodeOn(`mutant-${index}`, path.join(fixtureDirectory, 'mutants', mutant))
    if (exitCode === null) evidence.mutantsUnrunnable += 1
    else if (exitCode !== 0) evidence.mutantsKilled += 1
  }
  for (const [index, equivalent] of equivalents.entries()) {
    // 等价体必须**恰好**退出 0：跑不完（null）也算被杀，因为那时已经无从判断行为是否保持。
    if (exitCodeOn(`equivalent-${index}`, path.join(fixtureDirectory, 'equivalents', equivalent)) !== 0) evidence.equivalentsKilled += 1
  }
  const reasons = []
  if (evidence.originalExitCode === null) reasons.push('the suite could not run on the original sources')
  else if (evidence.originalExitCode !== 0) reasons.push(`the suite does not pass on the correct sources (exit ${evidence.originalExitCode})`)
  if (evidence.mutantsUnrunnable > 0) reasons.push(`${evidence.mutantsUnrunnable} mutant run(s) could not complete`)
  if (evidence.mutantsKilled < minKilled) reasons.push(`killed ${evidence.mutantsKilled} mutant(s), fewer than the required ${minKilled}`)
  if (evidence.equivalentsKilled > 0) reasons.push(`killed ${evidence.equivalentsKilled} behaviour-preserving equivalent(s)`)
  const passed = evidence.originalExitCode === 0 && evidence.mutantsUnrunnable === 0 && evidence.mutantsKilled >= minKilled && evidence.equivalentsKilled === 0
  return { evidence: reasons.length === 0 ? evidence : { ...evidence, reason: reasons.join('; ') }, passed }
}

// 未实现的种类必须**响亮地失败**，而不是回落到某一个默认分支上静默算出一个结论。
const implementations = { repro, mutation }

export async function verifyCriteria(verifierUrl) {
  const fixtureDirectory = path.dirname(fileURLToPath(verifierUrl))
  const [workspace, reportDirectory] = [process.argv[2], process.argv[3]]
  if (!workspace || !reportDirectory) throw new Error('usage: verify.mjs <workspace> <reportDirectory>')
  const criteria = JSON.parse(fs.readFileSync(path.join(fixtureDirectory, 'criteria.json'), 'utf8'))
  fs.rmSync(reportDirectory, { recursive: true, force: true })
  fs.mkdirSync(reportDirectory, { recursive: true })
  const implementation = implementations[criteria.kind]
  if (implementation === undefined) throw new Error(`no criteria implementation for kind: ${criteria.kind}`)
  const { evidence, passed } = implementation(fixtureDirectory, workspace, reportDirectory, criteria)
  // 产物与判据是同一份数据的两面：report.json 是给 Harness 读的**读数**，Harness 会照它自己那套规则
  // 复算一遍通过与否。两边若不一致，说明这份判据的规则与 Harness 认定的规则已经漂移，必须失败。
  fs.writeFileSync(path.join(reportDirectory, 'report.json'), `${JSON.stringify({ ...evidence, passed }, null, 2)}\n`)
  if (!passed) {
    process.stderr.write(`${evidence.reason ?? 'the criteria did not pass'}\n`)
    process.exit(1)
  }
  console.log(`acceptance passed: ${path.basename(fixtureDirectory)}`)
}
