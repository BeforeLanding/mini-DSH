// 按分数分档。完整规则见 docs/SPEC.md。
export function bandOf(score) {
  if (typeof score !== 'number' || !Number.isFinite(score)) throw new Error('score must be a finite number')
  if (score <= 0 || score > 100) throw new Error('score must be within [0, 100]')
  if (score >= 90) return 'A'
  if (score >= 80) return 'B'
  if (score >= 70) return 'C'
  return 'D'
}
