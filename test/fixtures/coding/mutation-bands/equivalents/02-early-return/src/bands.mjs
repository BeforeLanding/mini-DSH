// 行为保持的等价实现：把输入校验抽成一个函数，并把 if 链的顺序整个倒过来（从最低档往上排除）。
function assertAllowed(score) {
  if (typeof score !== 'number' || !Number.isFinite(score)) throw new Error('score must be a finite number')
  if (score < 0 || score > 100) throw new Error('score must be within [0, 100]')
}

export function bandOf(score) {
  assertAllowed(score)
  if (score < 70) return 'D'
  if (score < 80) return 'C'
  if (score < 90) return 'B'
  return 'A'
}
