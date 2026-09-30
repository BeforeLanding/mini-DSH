import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { corpusDigest, estimationCategories, estimatorDigest, loadReference, measure, round, sampleFiles } from '../scripts/estimation-corpus.js'
import type { EstimationCategory } from '../scripts/estimation-corpus.js'

// NX-08c 记录的结论：语料与参考 token 数固定时，估算器的偏差是确定值。估算器、语料或参考一变，这些断言
// 就会失败——这是有意的：文档里的分布与核验日期必须跟着重新测量，而不是继续引用旧数字。
// 重新测量的步骤见 docs/context-budget/CHANGES.md 的 NX-08c 一节。
const recorded: Record<EstimationCategory, { ratio: number; underestimates: number; worst: number }> = {
  chinese: { ratio: 1.2796, underestimates: 0, worst: 0.1712 },
  english: { ratio: 1.3986, underestimates: 0, worst: 0.3173 },
  code: { ratio: 1.1552, underestimates: 1, worst: -0.1579 },
  schema: { ratio: 1.1065, underestimates: 3, worst: -0.2252 },
}
const recordedOverall = { ratio: 1.1752, underestimates: 4, worst: -0.2252 }

test('estimation corpus covers all four categories with reference counts for every sample', async () => {
  const samples = await sampleFiles()
  const reference = await loadReference()
  assert.deepEqual(reference.corpus.categories, [...estimationCategories])
  for (const category of estimationCategories) {
    assert.equal(samples.filter(sample => sample.category === category).length, 10, category)
  }
  assert.equal(samples.length, reference.corpus.samples)
  for (const sample of samples) {
    assert.ok(sample.text.trim().length > 0, sample.id)
    const count = reference.counts[sample.id]
    assert.ok(count, `reference is missing ${sample.id}`)
    assert.equal(count.chars, [...sample.text].length, sample.id)
    assert.ok(count.tokens > 0 && count.asciiChars >= 0 && count.asciiChars <= count.chars, sample.id)
  }
})

test('pinned reference still matches the estimator and corpus it was measured against', async () => {
  const reference = await loadReference()
  const estimator = await estimatorDigest()
  assert.ok(
    estimator === reference.estimator.sha256,
    `src/core/token-estimator.ts changed (${estimator} != ${reference.estimator.sha256}): re-run the NX-08c measurement and update the recorded conclusions and 核验日期`,
  )
  const digest = corpusDigest(await sampleFiles())
  assert.ok(digest === reference.corpus.sha256, `corpus changed (${digest} != ${reference.corpus.sha256}): the reference token counts must be measured again`)
  assert.match(reference.verifiedAt, /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(reference.tokenizer.addSpecialTokens, false)
  assert.match(reference.tokenizer.sha256, /^[0-9a-f]{64}$/)
  assert.match(reference.tokenizer.url, /^https:\/\//)
})

test('corpus digest survives a CRLF checkout', async () => {
  const samples = await sampleFiles()
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-estimation-'))
  try {
    for (const category of estimationCategories) await fs.mkdir(path.join(directory, category))
    for (const sample of samples) {
      const [category, name] = sample.id.split('/') as [EstimationCategory, string]
      await fs.writeFile(path.join(directory, category, `${name}.txt`), sample.text.replace(/\n/g, '\r\n'))
    }
    // git 的 core.autocrlf 在 Windows 检出时会插入 CR，摘要必须只取决于内容而不是检出平台的换行风格。
    assert.equal(corpusDigest(await sampleFiles(directory)), (await loadReference()).corpus.sha256)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('recorded per-category estimate error still holds', async () => {
  const report = measure(await sampleFiles(), await loadReference())
  for (const entry of report.categories) {
    const expected = recorded[entry.category]
    assert.equal(round(entry.ratio), expected.ratio, `${entry.category}: aggregate ratio changed`)
    assert.equal(entry.underestimates, expected.underestimates, `${entry.category}: underestimating sample count changed`)
    assert.equal(round(entry.worstRelativeError), expected.worst, `${entry.category}: worst relative error changed`)
    assert.equal(entry.min, entry.worstRelativeError, entry.category)
  }
  assert.equal(round(report.overall.ratio), recordedOverall.ratio)
  assert.equal(report.overall.underestimates, recordedOverall.underestimates)
  assert.equal(round(report.overall.worstRelativeError), recordedOverall.worst)
})

test('the estimator is conservative on natural language and not uniformly safe on structured input', async () => {
  const report = measure(await sampleFiles(), await loadReference())
  const category = (name: EstimationCategory) => report.categories.find(entry => entry.category === name)!
  // 中文与英文全部样本高估：非 ASCII 记 1.0、ASCII 记 0.3，都高于官方 tokenizer 的实际比例。
  assert.equal(category('chinese').underestimates, 0)
  assert.ok(category('chinese').min > 0.1)
  assert.ok(category('english').min > 0.3)
  // 代码与 JSON 不是一致安全：两个类别都出现低估，且低估幅度超过 10% 的容量余量。
  for (const name of ['code', 'schema'] as const) assert.ok(category(name).worstRelativeError < -0.1, name)
  assert.ok(report.overall.worstRelativeError < -0.2)
  assert.equal(report.overall.underestimates, 4)
})
