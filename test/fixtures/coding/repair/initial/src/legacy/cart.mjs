// 历史副本：与现行实现同名，但已不被任何入口导入（见根目录 AGENTS.md）。
// 这一版把 percentOff 当百分数除以 100，却仍忽略单项折扣、也没有取整。
export function subtotal(items) {
  return items.reduce((sum, item) => sum + item.price * item.quantity, 0)
}

export function discount(amount, percentOff) {
  return amount - amount * percentOff / 100
}

export function total(items, percentOff) {
  return discount(subtotal(items), percentOff)
}
