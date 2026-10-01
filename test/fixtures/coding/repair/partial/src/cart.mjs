// 已知的中间态：只修好「单项折扣」这条规则（subtotal），整单百分数与取整仍未修。
// 它由 test/coding-fixtures.test.ts 钉住，供 NX-10-3 的演示展示「失败测试 → 再修复」。
export function subtotal(items) {
  return items.reduce((sum, item) => sum + item.price * item.quantity * (1 - (item.discount ?? 0)), 0)
}

export function discount(amount, percentOff) {
  return amount - amount * percentOff
}

export function total(items, percentOff) {
  return discount(subtotal(items), percentOff)
}
