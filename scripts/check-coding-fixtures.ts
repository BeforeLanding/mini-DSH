import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFixture, fixtureIds } from './coding-fixtures.js'
import type { FixtureId } from './coding-fixtures.js'

// 每个 fixture 的开跑前提，按种类各查各的。三类的前提不是同一件事，因此不能共用一句「初始态失败、
// 参考态通过」——对新种类来说那句话几乎恒真：它们的初始态失败只是因为**产物还不存在**，与判据有没有
// 分辨力无关。真正要量的是下面这几对正反例。
//
//  - edit     初始态失败且退出码为 1，参考态通过（历史行为，一字不变）
//  - repro    没放产物 → 必须判不过；放上 weak/ 里的**反例产物** → 必须判不过（钉住判据不是「能跑就行」）；
//             放上参考产物 → 必须判过，**并且读数里那一对退出码要显式成立**（缺陷上非零、参考实现上 0）。
//             最后半句是 FAIL_TO_PASS 本身：只看 passed 的话，「缺陷到底存不存在」没有任何证据。
//  - mutation 没放产物 → 必须判不过；放上 weak/ 里那份**公开检查**（它与工作区里的 check.mjs 逐字相同）
//             → 必须判不过，**并且它杀掉的变异体数要显式小于 minKilled**；放上参考套件 → 必须判过，且
//             杀数 ≥ minKilled。中间那半句是唯一能机械证明「阈值不是白送的」的方式：只说「参考套件过了」
//             的话，一个把 minKilled 定成 0 的 fixture 也能全绿。
const repository = fileURLToPath(new URL('../../', import.meta.url))

async function writeArtifact(id: FixtureId, fixture: Awaited<ReturnType<typeof createFixture>>, variant: 'oracle' | 'weak') {
  const source = path.join(repository, 'test', 'fixtures', 'coding', id, variant, fixture.artifact!.path)
  await fs.writeFile(path.join(fixture.workspace, fixture.artifact!.path), await fs.readFile(source, 'utf8'))
}

let failed = false
for (const id of fixtureIds) {
  const fixture = await createFixture(id)
  try {
    let report: Record<string, unknown>
    if (fixture.kind === 'edit') {
      const initial = await fixture.evaluate()
      await fixture.applyReference()
      const reference = await fixture.evaluate()
      report = { initial, reference, expected: !initial.passed && initial.exitCode === 1 && reference.passed }
    } else if (fixture.kind === 'repro') {
      // 顺序是刻意的：applyReference 把参考产物留在工作区里，之后回不到「没有产物」那一态。
      const missing = await fixture.evaluate()
      // 反例产物只检查两种实现都满足的性质，因此在这一台上也必须判不过。
      await writeArtifact(id, fixture, 'weak')
      const weak = await fixture.evaluate()
      await fixture.applyReference()
      const reference = await fixture.evaluate()
      const evidence = reference.evidence
      const failToPass = evidence?.kind === 'repro' && evidence.initialExitCode !== 0 && evidence.initialExitCode !== null && evidence.referenceExitCode === 0
      report = { missing, weak, reference, failToPass, expected: !missing.passed && !weak.passed && reference.passed && failToPass }
    } else {
      if (fixture.minKilled === undefined || fixture.artifact === undefined) throw new Error(`mutation fixture ${id} is missing its threshold or artifact`)
      const missing = await fixture.evaluate()
      await writeArtifact(id, fixture, 'weak')
      const weak = await fixture.evaluate()
      await fixture.applyReference()
      const reference = await fixture.evaluate()
      const kills = (acceptance: typeof weak): number | undefined => acceptance.evidence?.kind === 'mutation' ? acceptance.evidence.mutantsKilled : undefined
      const [weakKills, referenceKills] = [kills(weak), kills(reference)]
      // 反例套件必须在**正确的源码**上全绿（否则它是一份坏掉的公开检查，而不是一份弱的），且杀得不够。
      const weakRunsClean = weak.evidence?.kind === 'mutation' && weak.evidence.originalExitCode === 0
      report = {
        missing, weak, reference, minKilled: fixture.minKilled, weakKills, referenceKills,
        expected: !missing.passed && !weak.passed && weakRunsClean && reference.passed
          && weakKills !== undefined && weakKills < fixture.minKilled && referenceKills !== undefined && referenceKills >= fixture.minKilled,
      }
    }
    failed ||= report.expected !== true
    console.log(JSON.stringify({ fixture: id, kind: fixture.kind, ...report }))
  } finally { await fixture.close() }
}
if (failed) process.exitCode = 1
