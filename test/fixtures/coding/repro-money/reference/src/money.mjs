// 把金额取到两位小数。完整规则见 docs/SPEC.md。
export function roundMoney(amount) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) throw new Error('amount must be a finite number')
  const rounded = Math.round(Math.abs(amount) * 100)
  return amount < 0 && rounded !== 0 ? -rounded / 100 : rounded / 100
}
