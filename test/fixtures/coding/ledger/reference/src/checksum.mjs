import { toCents } from './summarize.mjs'

// 排期说明给的口径：金额换算成「分」的整数、**取绝对值**、再求和。
// 取绝对值这一步是关键：退款是负数，带符号相加得到的是净额，而这个校验和要的是流水规模。
export function checksum(entries) {
  return entries.reduce((total, entry) => total + Math.abs(toCents(entry.amount)), 0)
}
