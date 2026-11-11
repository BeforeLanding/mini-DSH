// 反例：看似合理的“防御式”写法，只接受 0 < discount < 1 的单项折扣；discount 为 1（该项免费）时被当成无折扣。
// 公开检查 check.mjs 能通过，但 src/AGENTS.md 明确 `1` 表示该项免费，隐藏验收器会拒绝它。
const keptFraction = (discount) => (discount > 0 && discount < 1 ? 1 - discount : 1)

export function subtotal(items) {
  return items.reduce((sum, item) => sum + item.price * item.quantity * keptFraction(item.discount ?? 0), 0)
}

export function discount(amount, percentOff) {
  return Math.round(amount * (1 - percentOff / 100) * 100) / 100
}

export function total(items, percentOff) {
  return discount(subtotal(items), percentOff)
}
