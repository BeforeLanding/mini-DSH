// 行为保持的等价实现：把分档表列出来，从高到低找第一个够得着的档位。
// 与工作区里那份的**文本**不同（没有 if 链，也没有 100 的上界与 90/80/70 的比较），行为逐条一致。
const BANDS = [
  [90, 'A'],
  [80, 'B'],
  [70, 'C'],
  [0, 'D'],
]

export function bandOf(score) {
  if (!Number.isFinite(score)) throw new Error('score must be a finite number')
  if (score < 0 || score > 100) throw new Error('score must be within [0, 100]')
  return BANDS.find(([floor]) => score >= floor)[1]
}
