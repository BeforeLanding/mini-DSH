// SPEC 第 2 节：金额是两位小数字符串，先换算成「分」的整数再相加。
// 不能走 `Number(amount) * 100`：`8.70 * 100` 是 869.9999999999999，round 之前每次都会差一分。
// 按字符串自己拼整数——去掉小数点、带上符号——全程没有浮点参与。
export function toCents(amount) {
  const negative = amount.startsWith('-')
  const digits = (negative ? amount.slice(1) : amount).replace('.', '')
  return (negative ? -1 : 1) * Number(digits)
}

export function summarize(entries) {
  const totals = new Map()
  for (const entry of entries) {
    const bucket = totals.get(entry.account) ?? { total: 0, count: 0 }
    bucket.total += toCents(entry.amount)
    bucket.count += 1
    totals.set(entry.account, bucket)
  }
  // 科目名由 [A-Za-z0-9_-] 组成，码位比较与 localeCompare 在这里等价，直接比字符串即可。
  return [...totals.entries()]
    .map(([account, bucket]) => ({ account, total: bucket.total, count: bucket.count }))
    .sort((left, right) => left.account < right.account ? -1 : left.account > right.account ? 1 : 0)
}
