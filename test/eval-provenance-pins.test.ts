import test from 'node:test'
import assert from 'node:assert/strict'
import { blindIds, boundedIds, screeningIds, sequenceIds } from '../scripts/coding-fixtures.js'
import { fixtureProvenance } from '../scripts/eval-provenance.js'
import type { FixtureId } from '../scripts/coding-fixtures.js'

// NX-37：把已发布结论所依赖的四份仪器各钉一个内容摘要。NX-08d 的 12/12（screening）、NX-08e 的两臂
// （pipeline）、NX-08f 的 audit、NX-08h 的 blind，都是对着**当时那份 fixture 内容**发布的；内容一变，
// 旧结论就不再对应同一个任务集。此前没有任何东西会因此变红——报告里的摘要要等下一次付费批次才会更新，
// 也就是说「改了 fixture」这个动作在花钱之前是无声的。这里让它在构建时点名，与 estimation.test.ts 把
// 语料与估算器的摘要钉住同一个道理。
// 需要有意改动仪器时：改完重跑受影响的批次、回填结论，再更新这里的数字——不要静默改数字。
// 覆盖范围只到已发布结论依赖的这四份；repair 是演示夹具、没有评测结论挂在它上面，因此不钉。
const pinned: Readonly<Record<string, { ids: readonly FixtureId[]; sha256: string; perFixture: Readonly<Record<string, string>> }>> = {
  screening: {
    ids: screeningIds,
    sha256: '30b593faf26d7a02bf9fd77fc10cce833036533cf2d7c5b6c19132d9d93d1b83',
    perFixture: {
      boundary: '1e642299e99a664278d6a2d415a73a9e10e7a0cb8fcd968f8f2c904102e38efd',
      options: '46fe82718dc8471da8313fdcbb6ffa56de2fee1852fcc5089f408600600f1e79',
      interface: '92ec677e22d81dab0750d7e3e3e6682f9b154ca36ae311e023e13ed58045292e',
      normalize: 'ecc7768a5b29f6b3201700da708652b2f1d7b262b2b2b5ca55505ea37c07a0fe',
      dedupe: 'dbd0aa7e8caab2e5ea1af1a3085aa728ad395c15e9a51f06b771c3c3beeae11b',
      pagination: '3fa0e618aa0fb28248d07e177f2a1d323f4fda85b2f9e57a20178078882f384d',
      query: 'a89b6d8e95215837e4b72ba46e50984695a6f9a3e08f54d8e1e40a6362db00a5',
      retry: '45c7aeacd0058a4df6c68af7f326ace8ddc97f3de86e393676172e191b48ef1b',
      merge: '757df9ff1b79124ae985862b69157f74c34f93f1aaca7b9b76e135e91659d6b4',
      csv: '6bc2a2af5e6b0491ceaf065579045be6f5d40961fa1c15f7e7c11c883f2ecdf9',
      inventory: 'dde6f3237894dd728477d7399382ea458ef95a93868126b83e58c88a257f0874',
      summary: 'c4ded42f96062c68f95a444da8ba94016e970b19e92c425557db83941d93336d',
    },
  },
  sequence: {
    ids: sequenceIds,
    sha256: 'db57b227e258574f742ce94c57c6abb1525e3e520096a7529d8673af390a7742',
    perFixture: { pipeline: 'c2f92c92b4f186f21c751542e81a8b50ad14a31375e3be9163117289f9aac339' },
  },
  bounded: {
    ids: boundedIds,
    sha256: 'be6279cf648d5be43c247f5d74f91b128c5a1203a4ce57e8b1df8dd688df4556',
    perFixture: { audit: '04097bafb5c003eb2e9b7af674198c8e3a49377e0acd98534134369fde097de9' },
  },
  blind: {
    ids: blindIds,
    sha256: '0f5d70264f7a9ea2e7e0813e0c75113f8891664b343e040e9c92a2d18e872748',
    perFixture: { blind: 'df42a296a431663e3fac08653f97741c141a9b87ae543e43ffc73efa85cffec1' },
  },
}

// 非空断言：护栏自己静默空转（比如 pinned 被清空、或 ids 变成空数组而摘要恒为同一值）时必须出声，
// 否则「钉住了」这句话是假的。NX-35 给同类护栏补的正是这一条。
test('the fixture pins cover every published instrument and none of them is empty', () => {
  assert.deepEqual(Object.keys(pinned).sort(), ['blind', 'bounded', 'screening', 'sequence'])
  for (const [instrument, entry] of Object.entries(pinned)) {
    assert.ok(entry.ids.length > 0, `${instrument} pins no fixture`)
    assert.deepEqual(Object.keys(entry.perFixture).sort(), [...entry.ids].sort(), `${instrument} pins a different set than it declares`)
  }
})

for (const [instrument, expected] of Object.entries(pinned)) {
  test(`${instrument} fixtures still match the revision their published conclusions came from`, async () => {
    // 逐字段断言而不是只比聚合摘要：摘要变化时 perFixture 会点名是哪一个 fixture 变了，人不必再去二分。
    assert.deepEqual(await fixtureProvenance(expected.ids), expected, `${instrument} fixtures changed: re-run the batch they carry and update its published conclusion before updating this pin`)
  })
}
