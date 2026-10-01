import { normalizeAmount, normalizeEmail, normalizeName } from './normalize.mjs'

const FIELDS = ['name', 'email', 'amount']

// 逐条记录把原始字段规整后与数据集给出的期望值比对，返回所有不一致项。返回空数组表示数据集已全部处于规范形式。
export function auditRecords(records) {
  const violations = []
  for (const record of records) {
    const expected = record.expected ?? {}
    const actual = {
      name: normalizeName(record.name),
      email: normalizeEmail(record.email),
      amount: normalizeAmount(record.amount),
    }
    for (const field of FIELDS) {
      if (actual[field] !== expected[field]) {
        violations.push({ id: record.id, field, actual: actual[field], expected: expected[field], record })
      }
    }
  }
  return violations
}
