// 把数据集里的原始字段规整成规范形式。audit.mjs 拿规整结果与数据集自带的期望值比对，report.mjs 打印不一致项。

export function normalizeName(value) {
  return String(value ?? '').trim()
}

export function normalizeEmail(value) {
  return String(value ?? '').trim()
}

export function normalizeAmount(value) {
  return String(Number(value))
}
