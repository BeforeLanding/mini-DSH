// 把金额取到两位小数。完整规则见 docs/SPEC.md。
export function roundMoney(amount) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) throw new Error('amount must be a finite number')
  return Math.round(amount * 100) / 100
}
