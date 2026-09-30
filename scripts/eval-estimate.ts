import { corpusDigest, estimatorDigest, loadReference, measure, round, sampleFiles } from './estimation-corpus.js'
import type { CategoryReport } from './estimation-corpus.js'

// NX-08c：把估算器与官方 tokenizer 的偏差打在台面上。参考值固定，估算值每次现算，因此本脚本同时也是
// 记录的结论是否仍然成立的检查：估算器一改，这里的数字就会变，脚本以退出码 1 提示重新测量并更新文档。
const samples = await sampleFiles()
const reference = await loadReference()
const digest = corpusDigest(samples)
const estimator = await estimatorDigest()
const report = measure(samples, reference)

const present = (entry: CategoryReport) => ({
  category: entry.category, samples: entry.samples, chars: entry.chars,
  asciiShare: round(entry.asciiChars / entry.chars, 4),
  referenceTokens: entry.referenceTokens, estimatedTokens: entry.estimatedTokens,
  ratio: round(entry.ratio), min: round(entry.min), p25: round(entry.p25), median: round(entry.median),
  p75: round(entry.p75), max: round(entry.max),
  underestimates: entry.underestimates, worstRelativeError: round(entry.worstRelativeError),
})

console.log(JSON.stringify({
  note: '估算器与 DeepSeek 官方离线 tokenizer 的输入偏差；只测字符级估算，不含 chat 模板开销',
  verifiedAt: reference.verifiedAt,
  reference: { name: reference.tokenizer.name, tool: reference.tokenizer.tool, url: reference.tokenizer.url, sha256: reference.tokenizer.sha256, addSpecialTokens: reference.tokenizer.addSpecialTokens },
  // 摘要相同表示被测量的估算器与记录结论时的版本一致；不同则下面的数字不再对应文档里的结论。
  estimator: { file: reference.estimator.file, sha256: estimator, matchesReference: estimator === reference.estimator.sha256 },
  corpus: { samples: samples.length, sha256: digest, matchesReference: digest === reference.corpus.sha256 },
  definition: '相对误差 =（估算 − 参考）/ 参考；正为高估，负为低估。ratio 为总量比 estimatedTokens / referenceTokens。',
  categories: report.categories.map(present),
  overall: present(report.overall),
  underestimates: report.samples.filter(sample => sample.relativeError < 0)
    .map(sample => ({ id: sample.id, relativeError: round(sample.relativeError), referenceTokens: sample.referenceTokens, estimatedTokens: sample.estimatedTokens })),
}, null, 2))

if (estimator !== reference.estimator.sha256) {
  console.error(`估算器已改变（${estimator} ≠ ${reference.estimator.sha256}）：重新测量并更新 NX-08c 的结论与核验日期`)
  process.exitCode = 1
} else if (digest !== reference.corpus.sha256) {
  console.error(`语料已改变（${digest} ≠ ${reference.corpus.sha256}）：参考 token 数需要重新测量`)
  process.exitCode = 1
}
