// 另一条产品线遗留的分数制辅助函数：这里 percentOff 传的是比例（0.15 表示 15%）。
// 购物车入口不使用它，见根目录 AGENTS.md。
export function applyPercent(amount, percentOff) {
  return amount * (1 - percentOff)
}
