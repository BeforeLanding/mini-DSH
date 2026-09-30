import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { estimateText } from '../src/core/token-estimator.js'

// NX-08c：估算误差实验的语料与比较逻辑。参考 token 数由 DeepSeek 官方离线 tokenizer 一次性测量后
// 固定在 reference.json 中；生成步骤需要 Python 与 transformers，不属于本仓库的构建依赖，因此 CI 只读取
// 固定结果，不重跑测量。
export const estimationCategories = ['chinese', 'english', 'code', 'schema'] as const
export type EstimationCategory = typeof estimationCategories[number]
const repository = fileURLToPath(new URL('../../', import.meta.url))
const corpusDirectory = path.join(repository, 'test', 'fixtures', 'estimation', 'corpus')
const referenceFile = path.join(repository, 'test', 'fixtures', 'estimation', 'reference.json')

export interface ReferenceSample { chars: number; asciiChars: number; tokens: number }
export interface EstimationReference {
  note: string
  verifiedAt: string
  tokenizer: { name: string; url: string; sha256: string; tool: string; vocabSize: number; addSpecialTokens: boolean }
  estimator: { file: string; sha256: string }
  corpus: { sha256: string; samples: number; categories: string[] }
  counts: Record<string, ReferenceSample>
}
export interface CorpusSample { id: string; category: EstimationCategory; text: string }
export interface SampleMeasurement {
  id: string; category: EstimationCategory; chars: number; asciiChars: number
  referenceTokens: number; estimatedTokens: number; relativeError: number
}
export interface CategoryReport {
  category: EstimationCategory; samples: number; chars: number; asciiChars: number
  referenceTokens: number; estimatedTokens: number; ratio: number
  min: number; p25: number; median: number; p75: number; max: number
  underestimates: number; worstRelativeError: number
}
export interface EstimationReport { samples: SampleMeasurement[]; categories: CategoryReport[]; overall: CategoryReport }

export async function sampleFiles(directory = corpusDirectory): Promise<CorpusSample[]> {
  const samples: CorpusSample[] = []
  for (const category of estimationCategories) {
    const entries = await fs.readdir(path.join(directory, category))
    for (const filename of entries) {
      if (!filename.endsWith('.txt')) throw new Error(`unexpected corpus entry: ${category}/${filename}`)
      // 统一为 LF 再摘要与计数：git 的 core.autocrlf 会把已提交的 LF 在 Windows 检出成 CRLF，
      // 若按检出内容计算，同一份语料和同一个估算器会在不同平台得到不同摘要与不同参考值。
      const text = (await fs.readFile(path.join(directory, category, filename), 'utf8')).replace(/\r\n/g, '\n')
      samples.push({ id: `${category}/${filename.slice(0, -4)}`, category, text })
    }
  }
  // 按 id 排序后再摘要，使摘要只取决于内容而不取决于目录枚举顺序。
  return samples.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

export function corpusDigest(samples: readonly CorpusSample[]): string {
  const hash = createHash('sha256')
  hash.update([...samples].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(sample => `${sample.id}\0${sample.text}`).join('\n'))
  return hash.digest('hex')
}

export async function estimatorDigest(): Promise<string> {
  // 与语料同样按 LF 取摘要，使摘要只反映代码内容，不随检出平台的换行风格变化。
  const source = await fs.readFile(path.join(repository, 'src', 'core', 'token-estimator.ts'), 'utf8')
  return createHash('sha256').update(source.replace(/\r\n/g, '\n'), 'utf8').digest('hex')
}

export async function loadReference(): Promise<EstimationReference> {
  return JSON.parse(await fs.readFile(referenceFile, 'utf8')) as EstimationReference
}

// 线性插值分位数：idx = (n-1) * p，取相邻两项按小数部分加权。样本量小，不做插值以外的平滑。
export function quantile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN
  const index = (sorted.length - 1) * p
  const lower = Math.floor(index), upper = Math.ceil(index)
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (index - lower)
}

function report(category: EstimationCategory | 'all', rows: readonly SampleMeasurement[]): CategoryReport {
  const errors = rows.map(row => row.relativeError).sort((a, b) => a - b)
  const estimatedTokens = rows.reduce((sum, row) => sum + row.estimatedTokens, 0)
  const referenceTokens = rows.reduce((sum, row) => sum + row.referenceTokens, 0)
  return {
    category: category as EstimationCategory, samples: rows.length, chars: rows.reduce((sum, row) => sum + row.chars, 0),
    asciiChars: rows.reduce((sum, row) => sum + row.asciiChars, 0),
    referenceTokens, estimatedTokens,
    // 汇总比值按总量计算：单个请求的额度判断用的是整份输入，而不是样本误差的平均值。
    ratio: referenceTokens === 0 ? Number.NaN : estimatedTokens / referenceTokens,
    min: quantile(errors, 0), p25: quantile(errors, 0.25), median: quantile(errors, 0.5), p75: quantile(errors, 0.75), max: quantile(errors, 1),
    underestimates: errors.filter(error => error < 0).length, worstRelativeError: errors[0] ?? Number.NaN,
  }
}

// 相对误差 =（估算 − 参考）/ 参考；正为高估，负为低估。低估是危险方向：额度判断会以为装得下。
export function measure(samples: readonly CorpusSample[], reference: EstimationReference): EstimationReport {
  const measured: SampleMeasurement[] = samples.map(sample => {
    const count = reference.counts[sample.id]
    if (!count) throw new Error(`reference is missing ${sample.id}`)
    const estimatedTokens = estimateText(sample.text)
    return {
      id: sample.id, category: sample.category, chars: count.chars,
      asciiChars: count.asciiChars, referenceTokens: count.tokens, estimatedTokens,
      relativeError: (estimatedTokens - count.tokens) / count.tokens,
    }
  })
  return {
    samples: measured,
    categories: estimationCategories.map(category => report(category, measured.filter(row => row.category === category))),
    overall: report('all', measured),
  }
}

export function round(value: number, digits = 4): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}
